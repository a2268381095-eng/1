// 桌面版外壳：只负责开一个窗口，界面和数据都在网页那一层（dist/index.html）。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("小恶魔文书启动失败");
}
