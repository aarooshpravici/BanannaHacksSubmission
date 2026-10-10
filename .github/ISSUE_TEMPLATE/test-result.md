---
name: Test result
about: Your PASS / FAIL list after a test session (smoke test or a share of the test plan).
title: "Test result: YOUR NAME, share A / B / C / smoke test, DATE"
---

<!-- Never paste a key, a password or the contents of a .env file. This repository is public. -->

**Tester:**

**Date and time:**

**Version** (run `git log -1 --format=%h` in the project folder and write what it prints; on the hosted demo write "hosted demo" and the page address):

**Computer** (model, macOS or Windows version, Apple chip / NVIDIA card / neither):

**Browser and version:**

**Top-right pill reads** (mock / online, mock providers / online / offline / demo):

**Shading line** (click the GEOMETRY row at the bottom of the sidebar and copy its last grey line, for example "shading: graphics chip, full quality"; write "none" if there is no such line. Also copy any grey note above the photo):

**What I ran** (smoke test / share A / share B / share C / group H demo / other):

## Setup

- Did SETUP.md work as written? (yes / no, and what you had to change):
- Minutes for the model download (SETUP step 4):
- Seconds per photo after that (case D-01):

## Smoke test (testing/README.md)

Write PASS or FAIL after each.

- Step 1 Open the page:
- Step 2 Load the portrait:
- Step 3 Left, then Right:
- Step 4 Drag the sun:
- Step 5 Shadows on an object:
- Step 6 Compare with the original:
- Step 7 Enhance:
- Step 8 Export:

## Test plan cases (testing/TEST_PLAN.md)

One line per case you ran: `ID  PASS / FAIL / NOT RUN  note`. For every FAIL, open a separate "Bug report" issue and put its number in the note.

```
U-01
U-02
```

## Picture quality scores (group Q), 1 = fake, 5 = like a real photo

```
Q-01
Q-02
Q-03
```

## Items from testing/PENDING.md that I checked

## The three worst things I saw

1.
2.
3.

## The best thing to show a judge

## Screenshots

<!-- Paste here (Cmd+V or Ctrl+V). -->
