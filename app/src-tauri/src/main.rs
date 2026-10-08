// 小恶魔文书 · 桌面版入口。Windows 下不弹黑色命令行窗口。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    xiaoemo_lib::run()
}
