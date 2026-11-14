;; Rutinas SIMD sobre la memoria emulada (importada). Se compila con tools/wasm/build.mjs -> src/wasm-accel.js
(module
  (import "e" "mem" (memory 16384 16384))
  ;; blitKey: copia píxeles de 32 bits cuyo valor != key (fila a fila); devuelve cuántos se escribieron
  (func (export "blitKey") (param $s i32) (param $sp i32) (param $d i32) (param $dp i32) (param $w i32) (param $h i32) (param $key i32) (result i32)
    (local $x i32) (local $v i32) (local $kv v128) (local $a v128) (local $m v128) (local $eq v128) (local $n4 i32) (local $writes i32) (local $si i32) (local $di i32) (local $vp i32)
    (local.set $kv (i32x4.splat (local.get $key)))
    (local.set $n4 (i32.and (local.get $w) (i32.const -4)))
    (block $done (loop $rows
      (br_if $done (i32.le_s (local.get $h) (i32.const 0)))
      (local.set $x (i32.const 0)) (local.set $si (local.get $s)) (local.set $di (local.get $d))
      (block $v4e (loop $v4
        (br_if $v4e (i32.ge_s (local.get $x) (local.get $n4)))
        (local.set $a (v128.load align=1 (local.get $si)))
        (local.set $m (i32x4.eq (local.get $a) (local.get $kv)))
        (v128.store align=1 (local.get $di) (v128.bitselect (v128.load align=1 (local.get $di)) (local.get $a) (local.get $m)))
        (local.set $eq (i32x4.add (local.get $eq) (local.get $m)))
        (local.set $si (i32.add (local.get $si) (i32.const 16))) (local.set $di (i32.add (local.get $di) (i32.const 16)))
        (local.set $vp (i32.add (local.get $vp) (i32.const 4)))
        (local.set $x (i32.add (local.get $x) (i32.const 4))) (br $v4)))
      (block $te (loop $t
        (br_if $te (i32.ge_s (local.get $x) (local.get $w)))
        (local.set $v (i32.load align=1 (local.get $si)))
        (if (i32.ne (local.get $v) (local.get $key)) (then (i32.store align=1 (local.get $di) (local.get $v)) (local.set $writes (i32.add (local.get $writes) (i32.const 1)))))
        (local.set $si (i32.add (local.get $si) (i32.const 4))) (local.set $di (i32.add (local.get $di) (i32.const 4)))
        (local.set $x (i32.add (local.get $x) (i32.const 1))) (br $t)))
      (local.set $s (i32.add (local.get $s) (local.get $sp))) (local.set $d (i32.add (local.get $d) (local.get $dp)))
      (local.set $h (i32.sub (local.get $h) (i32.const 1))) (br $rows)))
    ;; escritos = escalares + píxeles vectoriales + (eq acumula -1 por cada píxel igual)
    (i32.add (i32.add (local.get $writes) (local.get $vp))
      (i32.add (i32x4.extract_lane 0 (local.get $eq)) (i32.add (i32x4.extract_lane 1 (local.get $eq)) (i32.add (i32x4.extract_lane 2 (local.get $eq)) (i32x4.extract_lane 3 (local.get $eq))))))
  )
)
