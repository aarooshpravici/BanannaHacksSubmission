# Test photos for Relight

Everyone on the team should test with these same files, so that we all see the same thing.
The screenshots in `testing/screenshots/` were made with them.

All photos come from the sample pictures that ship with the scikit-image Python library
(`skimage.data`, version 0.26). Each one is public domain or CC0, which means anyone may copy,
change and share it without asking. The licence text below is quoted from scikit-image's own notes for each picture.

| File | Size (px) | What it is | Use it to check |
| --- | --- | --- | --- |
| `01-portrait-astronaut.jpg` | 512 x 512 | A person, head and shoulders (astronaut Eileen Collins) | The main test photo. Faces show light and shadow most clearly. |
| `02-object-coffee.jpg` | 600 x 400 | A coffee cup on a saucer on a wooden table | An object. The cup should throw a shadow on the table. |
| `03-animal-cat.jpg` | 451 x 300 | Close-up of a cat's face | An animal, with fur and a soft blurred background. |
| `04-dark-rocket.jpg` | 640 x 427 | A rocket on its launch pad at night | A dark photo with small bright lights. |
| `05-tall-astronaut-crop.jpg` | 288 x 512 | The astronaut cut to a tall, narrow shape | Layout: a photo that is taller than it is wide. |
| `06-wide-coffee-crop.jpg` | 600 x 200 | The coffee cup cut to a wide, short strip | Layout: a photo three times wider than it is tall. |
| `07-tiny-cat-200px.jpg` | 200 x 133 | The cat shrunk to a very small picture | A very small photo. It will look soft (blurry) when stretched to fill the screen. That is expected. |
| `08-huge-astronaut-3000px.jpg` | 3000 x 3000 | The astronaut enlarged to a very big picture | A very large photo. The app should shrink it and still work at normal speed. |
| `09-iphone-portrait.heic` | 512 x 512 | The astronaut as a HEIC file, the kind an iPhone saves and AirDrop delivers | A HEIC photo loads like any other. The drop box reads "Converting your photo…" for a moment first. |
| `10-iphone-sideways.heic` | 288 x 512 | The tall astronaut, stored lying on its side with a note in the file to turn it upright (as a phone held upright stores a photo) | The stored rotation is obeyed: the astronaut must appear upright, taller than wide. |
| `11-iphone-12mp.heic` | 4032 x 3024 | The coffee cup enlarged to the size of an iPhone photo (12 megapixels), stored in tiles as an iPhone does | A full-size phone photo. The app should shrink it and still be quick. |
| `broken-photo.heic` | (damaged) | The first 3000 bytes of `09`, so the picture's data is missing | The error message for a HEIC file that cannot be converted. |
| `not-an-image.txt` | (text) | A plain text file, not a picture | The error message for a file that is not an image. Drag it onto the drop box. |

## Where each one comes from

| Files | scikit-image name | Source | Licence |
| --- | --- | --- | --- |
| `01`, `05`, `08` | `skimage.data.astronaut()` | NASA Great Images database | Public domain: "No known copyright restrictions, released into the public domain." |
| `02`, `06` | `skimage.data.coffee()` | Photo by Rachel Michetti, courtesy of Pikolo Espresso Bar | CC0: "No copyright restrictions. CC0 by the photographer (Rachel Michetti)." |
| `03`, `07` | `skimage.data.chelsea()` | Photo by Stefan van der Walt | CC0: "No copyright restrictions. CC0 by the photographer (Stefan van der Walt)." |
| `04` | `skimage.data.rocket()` | SpaceX Photos (launch of DSCOVR on Falcon 9) | Public domain: "The image was captured by SpaceX and released in the public domain." |
| `09`, `10`, `broken-photo.heic` | `skimage.data.astronaut()` | As `01` | As `01`. |
| `11` | `skimage.data.coffee()` | As `02` | As `02`. |
| `not-an-image.txt` | (none) | Written for this project | Nothing to license. |

## What was changed

- All pictures were saved again as JPEG (quality 92; quality 90 for the 3000 px one).
- `05` is columns 80 to 368 of the astronaut picture, full height.
- `06` is rows 110 to 310 of the coffee picture, full width.
- `07` is the cat picture made smaller. `08` is the astronaut picture made bigger. Making a picture
  bigger does not add detail, so `08` looks soft when zoomed in.
- The `.heic` files were made from the JPEGs with the converter built into macOS
  (`sips -s format heic input.jpg --out output.heic`). `10` is `05` turned on its side and saved as a JPEG
  that says "turn me a quarter turn clockwise" (EXIF orientation 6); the converter carries that over as the
  HEIC file's own rotation. `11` is the middle of `02`, cut to 4:3 and enlarged to 4032 x 3024.
  `broken-photo.heic` is `head -c 3000` of `09`.

Other scikit-image samples were left out on purpose because their licence is less clear
(for example the coins and motorcycle pictures).
