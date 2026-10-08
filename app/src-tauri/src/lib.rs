// 桌面版外壳：开一个窗口，界面和数据都在网页那一层（dist/index.html）。
// http 插件让网页层直接调用各家 AI 接口（浏览器里会被跨域限制拦下）。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .run(tauri::generate_context!())
        .expect("小恶魔文书启动失败");
}
