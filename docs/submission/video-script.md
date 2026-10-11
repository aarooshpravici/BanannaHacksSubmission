# Relight demo video script (target 2:55, hard limit 3:00)

## Before you record

- Record in Chrome on the Mac, window 1440 x 900, at 100% zoom. Hide the bookmarks bar.
- Run the app with the backend on (so the status dot is not red) or use the hosted demo. The four samples work either way, and no shot needs the backend: shot 10 shows a still picture and does not click **Enhance**. On the hosted demo your own photo works too, but its first load downloads about 25 MB and a face shades flatter than the Portrait sample, so film the samples.
- Record the screen first with no voice, then read the words over it. It is much easier than doing both at once.
- Read slowly. Each row's words fit its time at a calm pace (about 135 words a minute). The Cat shot of the first draft is already cut. If you still run long, shorten shot 11.
- Things to avoid on camera, because they are known weak spots: the **Right** preset on the Portrait (hard diagonal shadow edge on the face), the light below a face (blotchy bands), and clicking **Detailed normals** with the backend off (a red bar appears).
- Shot 10 needs one still image: `proofs/live/relight_enhance.jpg` from the repository (it is also in the README). Open it in a second tab before you start. Its third panel is close to the original photo: that is the point the words make.

## Shots

| # | Time | On screen | Say |
|---|---|---|---|
| 1 | 0:00-0:14 | The first page with the four sample thumbnails. Do not click yet. | "Image models can relight a photo. But you cannot tell a text prompt exactly where the light goes. You type, you wait, you guess again. We wanted to just drag the light." |
| 2 | 0:14-0:30 | Click the **Portrait** sample. Grab the sun marker on the photo and drag it slowly: left side, over the top, upper right, back to upper left. Keep it above the chin. | "This is Relight. I pick a photo and drag the light. The shading follows my mouse, live, in the browser. Nothing is being generated while I drag. No waiting." |
| 3 | 0:30-0:45 | Still Portrait. In the **Light** panel click the presets in this order: **Left**, **Top**, **Low and warm**. Pause one second on each. Then move the **Intensity** slider up and down once, then put the mouse on the sun and scroll up, then down, so the sun grows and shrinks. Use a real mouse wheel: a trackpad can overshoot on camera. | "There are presets. Left. Top. Low and warm. I can also change how strong the light is. And if I scroll on the sun, the light comes nearer or moves back." |
| 4 | 0:45-0:55 | Click the **Coffee cup** sample. Click **Sweep**. Let the light go once around (about six seconds). Do not touch the mouse. (Not on the Portrait: Sweep passes below the face, where it looks blotchy.) | "Now a coffee cup. Sweep moves the light once around it. Watch the shadow swing round the cup." |
| 5 | 0:55-1:08 | Still Coffee cup. Click the **Left** preset. Turn the **Cast shadows** switch off, wait two seconds, turn it on again. Do it twice. | "This is with cast shadows off. And on. The cup now throws a shadow onto the saucer and the table. Off. On." |
| 6 | 1:08-1:23 | Still Coffee cup. Open the **Geometry** panel (click **Show**). Point the mouse at the **Depth** picture, then the **Normals** picture. | "This is what the app sees. On the left is depth: white is near, black is far. On the right are surface normals: the colour says which way each bit of surface faces." |
| 7 | 1:23-1:32 | Close Geometry (**Hide**). Press and hold **Hold to see original** for two seconds, release, hold again, release. | "If I hold this button, I see the original photo. Release, and it is relit. Original. Relit." |
| 8 | 1:32-1:42 | Click the **Rocket** sample. Click **Top**, then drag the sun slowly from the left side to the right side across the upper half. | "A third photo, a rocket at night. Same controls. The light slides across the tower and the structure around it." |
| 9 | 1:42-2:17 | Go back to **Portrait**. Open **Geometry** again and leave it open. Drag the sun slowly while you talk. For the last sentence, switch **Cast shadows** off and on once. | "How it works. Two pretrained models run once per photo: Depth Anything gives depth, and Marigold, a diffusion model, gives surface normals. Everything after that is our own code. Each pixel compares its surface direction with the direction to the light: that is the shading. For shadows, each pixel walks toward the light and checks what is in the way. Near shadows stay sharp; far ones blur and fade. All of it runs in a shader, every frame." |
| 10 | 2:17-2:33 | Switch to the tab with `proofs/live/relight_enhance.jpg` and leave it on screen. Point at the middle panel, then the right one. Do not click **Enhance** in the app. | "Enhance is optional. It sends our shaded picture to a hosted image model. This is our one real run: cleaner, but it lost most of our side lighting. So it is an extra, not the core." |
| 11 | 2:33-2:51 | Back to the app, **Rocket** sample, **Cast shadows** on, light at the left. Point the mouse at the slightly darker column on the sky beside a tower. | "Limits. The app guesses shape from one photo, so shadows are approximate: here, a faint dark column on the sky. Light from below a face looks blotchy. Tested on five devices so far. Next: specular highlights and more than one light." |
| 12 | 2:51-2:55 | The first page with the four thumbnails, or a plain card with the project name and the repository address. | "This is Relight. Thank you for watching." |

## Notes for whoever edits

- Total speech is about 364 words. At 135 words a minute, with the pauses the shots need, the table adds up to 2:55. Nobody has timed it aloud: time one read-through before recording, and keep the finished video under 3:00.
- Do not say a frame rate or a speed number. None has been measured on a second computer.
- The "what is next" list in shot 11 is a plan, not something built. Keep the word "Next".
