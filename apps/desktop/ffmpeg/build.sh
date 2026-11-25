#!/usr/bin/env bash
# Сборка ffmpeg для перекодирования видео в клиенте (src-tauri/src/transcode.rs).
#
#   build.sh <папка исходников ffmpeg> <готовый ffmpeg.exe>
#
# В CI запускается в MSYS2 (UCRT64), см. .github/actions/ffmpeg. Собирается
# только нужное: разбор MP4/MOV/MKV/AVI/TS/ASF, декодеры видео (HEVC,
# H.264 и другие, с аппаратным декодированием D3D11VA) и звука, кодирование
# в H.264 средствами Windows (Media Foundation, h264_mf) и в AAC, запись MP4.
# Без GPL-частей (libx264 и т. п.) — ffmpeg остаётся под LGPL, без сети и
# без чужих библиотек: один статический exe в несколько мегабайт.
#
# FFMPEG_TEST=1 — проверочная сборка не под Windows: вместо h264_mf и
# D3D11VA — кодировщик mpeg4 (только чтобы проверить набор частей).
set -euo pipefail

src=$(cd "$1" && pwd)
out=$2
build=$(mktemp -d)

join() {
  local IFS=,
  echo "$*"
}

decoders=(
  # видео
  hevc h264 mpeg4 mpeg2video mjpeg vc1 wmv3
  # звук
  aac aac_latm mp3float mp3 mp2 opus vorbis flac alac ac3 eac3 amrnb amrwb wmav2
  pcm_s16le pcm_s16be pcm_s24le pcm_s32le pcm_f32le pcm_u8 pcm_alaw pcm_mulaw
)
demuxers=(mov matroska avi mpegts asf flv)
parsers=(hevc h264 mpeg4video mpegvideo mjpeg vc1 aac aac_latm mpegaudio opus vorbis flac ac3)
encoders=(aac)
muxers=(mp4)
bsfs=(aac_adtstoasc extract_extradata)
protocols=(file pipe)
# buffer… — вход и выход графа фильтров, scale/format — 8 бит 4:2:0 и
# размер для кодировщика, transpose/hflip/vflip — поворот видео с телефона
filters=(buffer buffersink abuffer abuffersink scale format aformat aresample null anull transpose hflip vflip)
hwaccels=()
extra=()

if [[ ${FFMPEG_TEST:-} == 1 ]]; then
  encoders+=(mpeg4)
  extra+=(--enable-pthreads --disable-x86asm)
else
  encoders+=(h264_mf)
  hwaccels+=(hevc_d3d11va hevc_d3d11va2 h264_d3d11va h264_d3d11va2)
  extra+=(--enable-w32threads --enable-d3d11va --enable-mediafoundation --extra-ldflags=-static)
fi

cd "$build"
"$src/configure" \
  --disable-everything \
  --disable-autodetect \
  --disable-doc \
  --disable-debug \
  --disable-network \
  --disable-avdevice \
  --disable-ffplay \
  --disable-ffprobe \
  --enable-static \
  --disable-shared \
  --pkg-config-flags=--static \
  --enable-decoder="$(join "${decoders[@]}")" \
  --enable-demuxer="$(join "${demuxers[@]}")" \
  --enable-parser="$(join "${parsers[@]}")" \
  --enable-encoder="$(join "${encoders[@]}")" \
  --enable-muxer="$(join "${muxers[@]}")" \
  --enable-bsf="$(join "${bsfs[@]}")" \
  --enable-protocol="$(join "${protocols[@]}")" \
  --enable-filter="$(join "${filters[@]}")" \
  ${hwaccels[@]+--enable-hwaccel="$(join "${hwaccels[@]}")"} \
  "${extra[@]}"

make -j"$(nproc)" ffmpeg
exe=ffmpeg
[[ -f ffmpeg.exe ]] && exe=ffmpeg.exe
strip "$exe"
mkdir -p "$(dirname "$out")"
cp "$exe" "$out"
ls -la "$out"
rm -rf "$build"
