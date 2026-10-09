// AI 接入流程（一条路）：选提供商 → 粘贴 Key → 自动拉取模型 → 点「测试」发一条极短消息 → 成功。
// 失败就在当前页说原因，不跳走。这个组件既用在「AI 接入」界面，也用在第一次调用 AI 时就地弹出来。
// 下面另有「绘画」一段（可选）：选绘画接口、加绘画模型（从模型列表里挑或手动填），改了就存，不影响上面文字模型的流程。
import { allProviders, providerOf, getConfig, saveConfig, listModels, testModel, isDesktop,
  IMAGE_APIS, defaultImageApi, imageModelChoices, paintReady } from "../../core/ai.js";
import { h, icon, modal } from "../../core/ui.js";

/** 在 root 里画接入流程。opts.onDone(providerId) 测试成功后调用；opts.onPaintReady(providerId) 绘画配好（有 Key、接口、模型）后调用；opts.only 只显示某一家 */
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
    const paint = paintReady(c);
    const b = h("button.ai-prov" + (ok ? ".ok" : "") + (paint ? ".paint" : ""), { type: "button", "data-id": p.id },
      h("span.ai-prov-name", {}, p.name),
      h("span.ai-prov-state", {}, (ok ? `已接入 · ${(c.models || []).length} 个模型` : "未接入") + (paint ? " · 能画图" : "")),
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
        all.providers[id] = { ...c, models, ok: true, testModel: model, testedAt: Date.now(), modelsAt: Date.now() };
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
      paintSection({ p, id, conf, confNow, keyIn, models: () => models, onReady: opts.onPaintReady,
        refreshCard: (fresh) => { cfg.providers[id] = fresh; list.querySelector(`[data-id="${id}"]`).replaceWith(card(p)); } }),
      h("p.muted.small-note", {}, "Key 只存在这台电脑上，不会上传到别处。")));
    (p.custom ? baseIn : keyIn).focus();
  }

  if (opts.only) openFlow(opts.only);
}

/**
 * 「绘画」一段：绘画接口（OpenAI 图片接口 / Gemini 出图 / 不画图）+ 绘画模型（胶囊，能删；从模型列表里挑，或者手动填）。
 * 改了马上存进 providers[id].image；这一家还没测试过文字模型时也先把 Key 存上（ok 不变，文字那边照旧要测试）。
 */
function paintSection({ p, id, conf, confNow, keyIn, models, refreshCard, onReady }) {
  const img = { api: (conf.image && conf.image.api) || defaultImageApi(id), models: [...((conf.image && conf.image.models) || [])] };
  const apiSel = h("select.select.ai-paint-api", { "aria-label": "绘画接口" }, ...IMAGE_APIS.map((a) => h("option", { value: a.id, selected: a.id === img.api }, a.name)));
  const chips = h("div.ai-paint-models", { role: "list", "aria-label": "绘画模型" });
  const addIn = h("input.input.ai-paint-add", { placeholder: "手动填模型名，回车", "aria-label": "添加绘画模型", autocomplete: "off", spellcheck: "false" });
  const pickBtn = h("button.btn.small.ghost.ai-paint-pick-btn", { type: "button", "aria-expanded": "false" }, "从模型列表里挑");
  const pickBox = h("div.ai-paint-pick", { hidden: true });
  const note = h("p.ai-paint-note", { role: "status", "aria-live": "polite" });
  const body = h("div.ai-paint-body");

  async function save() {
    const all = await getConfig();
    const c = confNow();
    const old = all.providers[id] || {};
    img.models = [...new Set(img.models.map((m) => m.trim()).filter(Boolean))];
    conf.image = { api: img.api, models: [...img.models] };
    // 已经测试过的 Key 不在这里改（改 Key 走上面的测试）；还没存过 Key 的先存上，画图要用
    all.providers[id] = { ...old, ...(old.key ? {} : c.key ? { key: c.key } : {}), ...(p.custom && !old.base ? { base: c.base, name: c.name } : {}), image: conf.image };
    if (!old.key && c.key) conf.key = c.key;
    await saveConfig(all);
    render();
    refreshCard(all.providers[id]);
    if (paintReady(all.providers[id]) && onReady) onReady(id);
  }

  function render() {
    body.hidden = img.api === "none";
    chips.replaceChildren(...img.models.map((m) => {
      const x = h("button.ai-paint-x", { type: "button", "aria-label": `去掉 ${m}`, title: "去掉这个模型" }, icon("close"));
      x.addEventListener("click", () => { img.models = img.models.filter((v) => v !== m); save(); });
      return h("span.ai-paint-chip", { role: "listitem", "data-model": m }, h("span.ai-paint-chip-t", {}, m), x);
    }));
    if (!img.models.length) chips.append(h("span.ai-paint-none", {}, "还没有绘画模型"));
    const key = (conf.key || confNow().key || "").trim();
    note.className = "ai-paint-note";
    if (img.api === "none") note.textContent = "这一家不用来画图。";
    else if (!key) note.textContent = "先在上面粘贴 Key。";
    else if (!img.models.length) note.textContent = "加一个绘画模型就能画图了。";
    else { note.textContent = "能画图了：封面制作、角色形象里用。单价第一次画图时在确认卡上填。"; note.classList.add("ok"); }
    if (!pickBox.hidden) fillPick();
  }

  function fillPick() {
    const cands = imageModelChoices(id, models());
    const all = cands.filter((m) => !img.models.includes(m));
    pickBox.replaceChildren(...(all.length ? all.map((m) => {
      const b = h("button.chip.ai-paint-cand", { type: "button", "data-model": m }, "＋ " + m);
      b.addEventListener("click", () => { img.models.push(m); save(); });
      return b;
    }) : [h("span.muted.ai-paint-empty", {}, cands.length ? "看起来能画图的都加上了。别的可以手动填。"
      : models().length ? "拉到的模型里没有看起来能画图的（名字里带 image、dall-e、imagen、flux 这些）。手动填一个。" : "先拉取模型列表，或者手动填。")]));
  }

  apiSel.addEventListener("change", () => { img.api = apiSel.value; save(); });
  keyIn.addEventListener("input", () => render());
  addIn.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    const v = addIn.value.trim();
    if (!v) return;
    if (!img.models.includes(v)) img.models.push(v);
    addIn.value = "";
    save();
  });
  pickBtn.addEventListener("click", () => {
    pickBox.hidden = !pickBox.hidden;
    pickBtn.setAttribute("aria-expanded", String(!pickBox.hidden));
    if (!pickBox.hidden) fillPick();
  });
  body.append(
    h("div.field", {}, h("span", {}, "绘画模型"), chips, h("div.row.ai-paint-row", {}, addIn, pickBtn), pickBox));
  render();
  return h("section.ai-paint", { "aria-label": "绘画" },
    h("h4.ai-paint-h", {}, icon("brush"), "绘画", h("span.ai-paint-opt", {}, "可选")),
    h("label.field", {}, h("span", {}, "绘画接口"), apiSel),
    body, note);
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
