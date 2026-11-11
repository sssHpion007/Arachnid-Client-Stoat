// скрываем консольное окно в Windows-релизе
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    arachnid_client_lib::run();
}
