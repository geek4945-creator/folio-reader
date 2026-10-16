#!/bin/sh
# Regenerates tests/fixtures/audio/* (needs ffmpeg). Tiny synthetic tones; none of this is copyrighted material.
set -e; cd "$(dirname "$0")/audio"

# 3-part book as separate mp3s with ID3 tags + cover (names deliberately sort differently from track order of creation)
for i in 1 2 3; do
  f=$((200*i+200))
  ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=$f:duration=4" -i cover.png -map 0 -map 1 -c:a libmp3lame -b:a 32k -c:v mjpeg -id3v2_version 3 \
    -metadata title="Part $i" -metadata artist="Test Narrator" -metadata album="Tone Story" -metadata track="$i" -metadata:s:v title="Cover" -metadata:s:v comment="Cover (front)" "story-0$i.mp3"
done
# untagged mp3
ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=330:duration=3" -c:a libmp3lame -b:a 32k "plain_clip.mp3"
# m4b with Nero chapters (chpl) + tags + cover
cat > /tmp/chap.txt <<C
;FFMETADATA1
title=Chaptered Book
artist=Chap Author
album=Chaptered Book
[CHAPTER]
TIMEBASE=1/1000
START=0
END=3000
title=Opening
[CHAPTER]
TIMEBASE=1/1000
START=3000
END=7000
title=The Middle
[CHAPTER]
TIMEBASE=1/1000
START=7000
END=10000
title=Finale
C
ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=440:duration=10" -i cover.png -i /tmp/chap.txt -map 0:a -map 1:v -map_metadata 2 -map_chapters 2 -c:a aac -b:a 32k -c:v mjpeg -disposition:v:0 attached_pic -f ipod chaptered.m4b
# mp3 with ID3 CHAP frames
ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=500:duration=9" -i /tmp/chap.txt -map 0:a -map_metadata 1 -map_chapters 1 -c:a libmp3lame -b:a 32k -id3v2_version 3 id3chap.mp3
# ogg + aac + m4a
ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=600:duration=3" -c:a libvorbis -q:a 0 -metadata title="Ogg Tone" -metadata artist="Ogg Artist" tone.ogg
ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=700:duration=3" -c:a aac -b:a 32k -f adts tone.aac
ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=800:duration=3" -i cover.png -map 0:a -map 1:v -c:a aac -b:a 32k -c:v mjpeg -disposition:v:0 attached_pic -metadata title="M4A Tone" -metadata artist="M4A Artist" -metadata album="M4A Album" -f ipod tagged.m4a
# zip of three mp3s (stored out of order)
rm -f book.zip; mkdir -p /tmp/zipb && cp story-03.mp3 /tmp/zipb/ch10.mp3 && cp story-01.mp3 /tmp/zipb/ch2.mp3 && cp story-02.mp3 /tmp/zipb/ch1.mp3
python3 - <<'PY'
import zipfile
with zipfile.ZipFile('book.zip','w',zipfile.ZIP_STORED) as z:
    for n in ['ch10.mp3','ch2.mp3','ch1.mp3']: z.write('/tmp/zipb/'+n, 'Tone Story/'+n)
PY
# QuickTime-style chapter track (text track referenced by tref/chap)
ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=440:duration=10" -i /tmp/chap.txt -map 0:a -map_metadata 1 -map_chapters 1 -c:a aac -b:a 32k -f mov qtchap.m4b
# hide the Nero chpl atom (rename to 'free') so only the QuickTime text track carries the chapters
python3 - <<'PY'
d=bytearray(open('qtchap.m4b','rb').read())
while d.find(b'chpl')>=0: i=d.find(b'chpl'); d[i:i+4]=b'free'
open('qtchap.m4b','wb').write(d)
PY
# fake Audible-style file (copy-protected container) for the DRM message
printf '\000\000\000\030ftypaax \000\000\000\000aax mp42\000\000\000\010free' > protected.aax

# 2-minute book with ID3 CHAP chapters at 0 / 40 / 80 s (skip, scrub, speed, sleep-at-chapter-end and chapter-list tests)
cat > /tmp/chap2.txt <<C
;FFMETADATA1
title=Long Tone
artist=Long Author
album=Long Tone
[CHAPTER]
TIMEBASE=1/1000
START=0
END=40000
title=Part One
[CHAPTER]
TIMEBASE=1/1000
START=40000
END=80000
title=Part Two
[CHAPTER]
TIMEBASE=1/1000
START=80000
END=120000
title=Part Three
C
ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=262:duration=120" -i cover.png -i /tmp/chap2.txt -map 0:a -map 1:v -map_metadata 2 -map_chapters 2 -ac 1 -ar 22050 -c:a libmp3lame -b:a 24k -c:v mjpeg -id3v2_version 3 -metadata:s:v title="Cover" -metadata:s:v comment="Cover (front)" long.mp3
