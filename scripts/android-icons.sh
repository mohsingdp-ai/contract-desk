#!/bin/sh
# Makes the Android app icon and launch screen from the web app's icons (client/public). Needs ImageMagick.
# Run from the repo root after changing the icons: sh scripts/android-icons.sh
set -e
res=android/app/src/main/res
bg='#17160f' # the icon's background colour, also the launch screen's (values/ic_launcher_background.xml)
# density: launcher icon size, adaptive-icon foreground size (108 dp)
for d in mdpi:48:108 hdpi:72:162 xhdpi:96:216 xxhdpi:144:324 xxxhdpi:192:432; do
  name=${d%%:*} rest=${d#*:}
  icon=${rest%%:*} fg=${rest#*:}
  magick client/public/icon-maskable-512.png -resize "${fg}x${fg}" -depth 8 "$res/mipmap-$name/ic_launcher_foreground.png"
  magick client/public/icon-512.png -resize "${icon}x${icon}" -depth 8 "$res/mipmap-$name/ic_launcher.png"
  magick client/public/icon-maskable-512.png -resize "${icon}x${icon}" \
    \( +clone -alpha transparent -fill white -draw "circle $((icon / 2)),$((icon / 2)) $((icon / 2)),0" \) \
    -compose DstIn -composite -depth 8 "$res/mipmap-$name/ic_launcher_round.png"
done
# Launch screen before Android 12 (Android 12+ draws its own from the icon): the mark centred on the dark background.
for f in "$res"/drawable*/splash.png; do
  size=$(magick identify -format '%w %h' "$f")
  w=${size% *} h=${size#* }
  mark=$(((w < h ? w : h) / 2))
  magick -size "${w}x${h}" "xc:$bg" \( client/public/icon-maskable-512.png -resize "${mark}x${mark}" \) -gravity center -composite -depth 8 "$f"
done
