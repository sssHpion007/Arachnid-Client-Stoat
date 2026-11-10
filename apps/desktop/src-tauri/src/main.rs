// скрываем консольное окно в Windows-релизе
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri_stoat_lib::run();
}
