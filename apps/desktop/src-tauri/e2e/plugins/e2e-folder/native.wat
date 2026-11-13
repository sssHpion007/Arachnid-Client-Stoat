;; Нативный модуль плагина e2e-folder (native.wasm собран из этого текста):
;;   python -m pip install wasmtime
;;   python -c "import wasmtime,pathlib; pathlib.Path('native.wasm').write_bytes(wasmtime.wat2wasm(pathlib.Path('native.wat').read_text()))"
;;
;; echo     — возвращает вход как есть;
;; greeting — значение ключа "greeting" из хранилища плагина (или null).
(module
  (import "arachnid" "output" (func $output (param i32 i32)))
  (import "arachnid" "storage_get" (func $get (param i32 i32) (result i64)))
  (memory (export "memory") 1)
  (global $next (mut i32) (i32.const 1024))
  (data (i32.const 0) "greeting")
  (data (i32.const 16) "null")
  ;; простейший распределитель: память не освобождается
  (func (export "arachnid_alloc") (param $len i32) (result i32)
    (local $ptr i32)
    (local.set $ptr (global.get $next))
    (global.set $next (i32.add (global.get $next) (local.get $len)))
    (local.get $ptr))
  (func (export "echo") (param $ptr i32) (param $len i32) (result i32)
    (call $output (local.get $ptr) (local.get $len))
    (i32.const 0))
  (func (export "greeting") (param i32 i32) (result i32)
    (local $packed i64)
    (local.set $packed (call $get (i32.const 0) (i32.const 8)))
    (if (i64.eq (local.get $packed) (i64.const -1))
      (then (call $output (i32.const 16) (i32.const 4)))
      (else
        (call $output
          (i32.wrap_i64 (i64.shr_u (local.get $packed) (i64.const 32)))
          (i32.wrap_i64 (local.get $packed)))))
    (i32.const 0)))
