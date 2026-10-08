// AI 接入流程（一条路）：选提供商 → 粘贴 Key → 自动拉取模型 → 点「测试」发一条极短消息 → 成功。
// 失败就在当前页说原因，不跳走。这个组件既用在「AI 接入」界面，也用在第一次调用 AI 时就地弹出来。
import { allProviders, providerOf, getConfig, saveConfig, listModels, testModel, isDesktop } from "../../core/ai.js";
import { h, icon, modal } from "../../core/ui.js";

/** 在 root 里画接入流程。opts.onDone(providerId) 测试成功后调用；opts.only 只显示某一家 */
export async function renderSetup(root, opts = {}) {
  const cfg = await getConfig();
  root.replaceChildren();
  const list = h("div.ai-prov-list");
  const flow = h("div.ai-flow");
  root.append(
    isDesktop() ? null : h("p.ai-web-note", {}, "网页版里有的接口会被浏览器的跨域限制拦下，接不上时改用桌面版就行。"),
    list, flow);

  const main = allProviders().filter((p) => !p.custom);
  const custom = allProviders().filter((p) => p.custom);
  const card = (p) => {
    const c = cfg.providers[p.id];
    const ok = c && c.ok;
    const b = h("button.ai-prov" + (ok ? ".ok" : ""), { type: "button", "data-id": p.id },
      h("span.ai-prov-name", {}, p.name),
      h("span.ai-prov-state", {}, ok ? `已接入 · ${(c.models || []).length} 个模型` : "未接入"),
      p.note ? h("span.ai-prov-note", {}, p.note) : null);
    b.addEventListener("click", () => openFlow(p.id));
    return b;
  };
  main.forEach((p) => list.append(card(p)));
  const more = h("details.ai-more", {}, h("summary", {}, "更多：自定义接口（兼容 OpenAI 格式的地址都能接）"), ...custom.map(card));
  list.append(more);

  async function openFlow(id) {
    list.querySelectorAll(".ai-prov").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.id === id)));
    const p = providerOf(id);
    const cfgNow = await getConfig();
    const conf = { ...(cfgNow.providers[id] || {}) };
    const keyIn = h("input.input", { type: "password", value: conf.key || "", placeholder: p.keyHint || "粘贴 Key", autocomplete: "off", spellcheck: "false", "aria-label": "Key" });
    const show = h("button.btn.small.ghost", { type: "button" }, "显示");
    show.addEventListener("click", () => { keyIn.type = keyIn.type === "password" ? "text" : "password"; show.textContent = keyIn.type === "password" ? "显示" : "隐藏"; });
    const baseIn = p.custom ? h("input.input", { value: conf.base || "", placeholder: "接口地址，比如 https://example.com/v1", "aria-label": "接口地址" }) : null;
    const nameIn = p.custom ? h("input.input", { value: conf.name || "", placeholder: "给它起个名字（可空）", "aria-label": "名字" }) : null;
    const modelSel = h("select.select", { "aria-label": "测试用的模型", disabled: !conf.models || !conf.models.length });
    const modelFilter = h("input.input.ai-model-filter", { placeholder: "筛选模型名", "aria-label": "筛选模型" });
    const status = h("div.ai-status", { role: "status", "aria-live": "polite" });
    const fetchBtn = h("button.btn", { type: "button" }, "拉取模型列表");
    const testBtn = h("button.btn.primary", { type: "button", disabled: !conf.models || !conf.models.length }, "测试");
    const removeBtn = conf.key ? h("button.btn.ghost.small", { type: "button" }, "删掉这个接入") : null;
    let models = (conf.models || []).map((m) => (typeof m === "string" ? { id: m, name: m } : m));

    const fillModels = () => {
      const q = modelFilter.value.trim().toLowerCase();
      modelSel.replaceChildren(...models.filter((m) => !q || m.id.toLowerCase().includes(q) || (m.name || "").toLowerCase().includes(q))
        .map((m) => h("option", { value: m.id, selected: m.id === conf.testModel }, m.id + (m.name && m.name !== m.id ? `（${m.name}）` : ""))));
      modelSel.disabled = !models.length;
      testBtn.disabled = !models.length;
    };
    fillModels();
    modelFilter.addEventListener("input", fillModels);

    const say = (kind, what, why) => {
      status.className = "ai-status " + kind;
      status.replaceChildren(h("b", {}, what), why ? h("span", {}, why) : null);
    };
    const confNow = () => ({ ...conf, key: keyIn.value.trim(), ...(p.custom ? { base: baseIn.value.trim(), name: nameIn.value.trim() } : {}) });

    async function fetchModels() {
      const c = confNow();
      if (!c.key) { say("err", "先粘贴 Key。", p.keyUrl ? "不知道去哪拿：点上面的「去拿 Key」。" : ""); keyIn.focus(); return false; }
      say("busy", "正在拉取模型列表……");
      fetchBtn.disabled = true;
      try {
        models = await listModels(id, c);
        say("ok", `拉到 ${models.length} 个模型。`, "选一个点「测试」。");
        fillModels();
        return true;
      } catch (e) {
        say("err", e.what || "拉取失败。", e.why || "");
        models = [];
        fillModels();
        return false;
      } finally { fetchBtn.disabled = false; }
    }

    async function test() {
      const c = confNow();
      const model = modelSel.value;
      if (!model) return;
      say("busy", `正在用 ${model} 发一条很短的消息……`);
      testBtn.disabled = true;
      try {
        const r = await testModel(id, c, model);
        const all = await getConfig();
        all.providers[id] = { ...c, models, ok: true, testModel: model, testedAt: Date.now() };
        await saveConfig(all);
        say("ok", "接好了。", `${p.custom ? (c.name || "自定义接口") : p.name} 回复：「${r.text.slice(0, 40)}」`);
        list.querySelector(`[data-id="${id}"]`).replaceWith(card(p));
        opts.onDone && opts.onDone(id, model);
      } catch (e) {
        say("err", e.what || "测试没通过。", e.why || "");
        if (e.category === "auth") keyIn.focus();
      } finally { testBtn.disabled = !models.length; }
    }

    keyIn.addEventListener("paste", () => setTimeout(() => { if (keyIn.value.trim() && (!p.custom || baseIn.value.trim())) fetchModels(); }, 0));
    keyIn.addEventListener("keydown", (e) => { if (e.key === "Enter" && !(e.isComposing || e.keyCode === 229)) fetchModels(); });
    fetchBtn.addEventListener("click", fetchModels);
    testBtn.addEventListener("click", test);
    if (removeBtn) removeBtn.addEventListener("click", async () => {
      const all = await getConfig();
      delete all.providers[id];
      await saveConfig(all);
      renderSetup(root, opts);
    });

    flow.replaceChildren(h("div.ai-steps", {},
      h("h3.ai-flow-title", {}, (p.custom ? "自定义接口" : p.name) + " 接入"),
      p.custom ? h("label.field", {}, h("span", {}, "① 接口地址"), baseIn) : null,
      p.custom ? h("label.field", {}, h("span", {}, "名字"), nameIn) : null,
      h("label.field", {}, h("span", {}, (p.custom ? "②" : "①") + " 粘贴 Key", p.keyUrl ? h("a", { href: p.keyUrl, target: "_blank", rel: "noopener" }, "去拿 Key") : null),
        h("div.row", {}, keyIn, show)),
      h("div.field", {}, h("span", {}, (p.custom ? "③" : "②") + " 拉取可用的模型"), h("div.row", {}, fetchBtn, modelFilter), modelSel),
      h("div.row", {}, testBtn, h("span.muted.small-note", {}, "会发一条很短的消息，花费不到一分钱"), h("span.spacer"), removeBtn),
      status,
      h("p.muted.small-note", {}, "Key 只存在这台电脑上，不会上传到别处。")));
    (p.custom ? baseIn : keyIn).focus();
  }

  if (opts.only) openFlow(opts.only);
}

/** 第一次用 AI、还没接任何一家时，就地弹出接入流程；接好返回 providerId，关掉返回 null */
export function setupModal() {
  return new Promise((resolve) => {
    let done = null;
    const body = h("div.ai-setup-modal");
    const m = modal({
      title: "先接一个 AI",
      body: h("div", {}, h("p.modal-text", {}, "选一家，粘贴 Key，测试通过就能用。接好后接着做刚才的事。"), body),
      wide: true,
      onClose: () => resolve(done),
    });
    renderSetup(body, { onDone: (id) => { done = id; setTimeout(() => m.close(true), 700); } });
  });
}

export { icon };
