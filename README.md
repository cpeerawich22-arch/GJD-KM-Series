# KM005 Web Control

Control the lighting of the **GOOJODOQ KM005** keyboard from your browser. Nothing to install: the page talks to the keyboard directly through [WebHID](https://developer.mozilla.org/docs/Web/API/WebHID_API).

> Unofficial, community-made project built by reverse-engineering the keyboard's USB protocol. Not affiliated with GOOJODOQ.

## Use it

1. Open the page in **Google Chrome** or **Microsoft Edge** on a computer (Firefox and Safari do not support WebHID yet).
2. Plug in the USB cable and switch the keyboard to **wired mode** (lighting cannot be changed over 2.4G or Bluetooth).
3. Press **Connect keyboard** and pick KM005.
4. Change effect, color, brightness and speed. Settings are stored on the keyboard, so they stay when you switch back to wireless.

Effect names and saved colors are kept in the browser you use.

## Protocol

Vendor-defined HID interface (usage page `0xFF00`, usage `0x01`), 64-byte reports, no report ID.

| Direction | Format |
|---|---|
| Out | `55 <cmd>` + 8 zero bytes + data |
| In | `AA <cmd>` + echo of the 8 bytes + data |

- `55 05` reads the state, `55 06 <state>` writes it.
- State, 9 bytes: `[effect 00–0E] [brightness 00–FF] [speed 00 fastest … 05 slowest] [?] [1 = rainbow / 0 = single color] [?] [R] [G] [B]`
- Changing the effect makes the keyboard go back to rainbow; the RGB bytes are kept.
- Effects 1, 3 and 15 have a built-in rainbow and effect 10 uses random colors, so color settings do nothing there.

## Files

- `index.html`, `app.css`, `app.js`: interface
- `km-hid.js`: WebHID connection and settings (localStorage)