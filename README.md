# mermaid-pictures

A Claude Code mod that draws the `mermaid` blocks of an assistant reply as pictures in the transcript, in place of their source. The stored message does not change, so ctrl+o still shows the source.

Rendering runs on your machine. Diagram source is never sent to a rendering service.

![A Mermaid sequence diagram drawn as a picture inside a Claude Code reply in Ghostty](docs/screenshot.png)

## Requirements

- A terminal with the kitty graphics protocol: Ghostty or kitty. Elsewhere, and inside tmux, the mod leaves the source as it was.
- A Mermaid renderer: `mmdr`, the default, or `mmdc`.

## Install the mod

At the prompt of a Claude Code terminal session:

```
/plugin install mermaid-pictures --marketplace andreagrandi/claude-mermaid-mod
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```sh
claude plugin install mermaid-pictures --marketplace andreagrandi/claude-mermaid-mod
```

The mod needs a renderer, described next.

## Install mmdr

`mmdr` is the binary of [mermaid-rs-renderer](https://github.com/1jehuang/mermaid-rs-renderer). It is written in Rust, needs no browser, and renders a diagram in tens of milliseconds.

1. Install a Rust toolchain if you have none. With Homebrew, run `brew install rust`. Otherwise use [rustup](https://rustup.rs).
2. Install the renderer:

   ```sh
   cargo install mermaid-rs-renderer
   ```

   Cargo puts the binary in `~/.cargo/bin/mmdr`.
3. Check it works:

   ```sh
   printf 'flowchart TD\n  A --> B\n' | ~/.cargo/bin/mmdr -i - -o /tmp/check.png -e png
   ```

The mod looks for `mmdr` on your `PATH` first, then in `~/.cargo/bin`, so you don't need to add Cargo's folder to your `PATH`. If the binary lives somewhere else, set the renderer path option described below.

`mmdr` reimplements Mermaid's layout, so some diagrams differ from what mermaid.js draws. Sequence diagrams and flowcharts come out right. In version 0.3.1, ER diagrams keep the quotes around relationship labels, class diagrams drop multiplicity labels such as `"1"` and `"*"`, and state diagram labels can overlap.

## Use mmdc instead

`mmdc` comes from [mermaid-cli](https://github.com/mermaid-js/mermaid-cli). It draws what mermaid.js draws, but it starts a headless Chromium for every diagram, which takes a few seconds.

```sh
npm install -g @mermaid-js/mermaid-cli
npx puppeteer browsers install chrome-headless-shell
```

Then set the renderer option to `mmdc`.

## Options

Both options are rows in `/config`. You can also set them in `settings.json` under `pluginConfigs`:

```json
{
  "pluginConfigs": {
    "mermaid-pictures": {
      "renderer": "mmdr",
      "rendererPath": ""
    }
  }
}
```

- `renderer`: `mmdr` or `mmdc`. The default is `mmdr`.
- `rendererPath`: the absolute path of the renderer binary. Leave it empty to look the renderer up on your `PATH`, then in `~/.cargo/bin`.

## How it works

1. When a turn ends, and when a session starts or resumes, the mod reads the main conversation and finds each closed `mermaid` fence.
2. It renders each new diagram once to a PNG in the mod's data folder. It uses Mermaid's dark theme, or the light one when your Claude Code theme is a light one. The cache keeps the newest 100 PNGs.
3. When a reply block holds a diagram with a PNG ready, the mod draws the picture in its place. Claude Code draws the prose around it as usual.
4. A diagram still rendering, or one that failed, shows as source. Render errors go to the debug log, `claude --debug`.

Pictures are sized from the PNG and the transcript width, and take at most 60% of the screen's rows. Claude Code reports no pixel size for a terminal cell, so the mod assumes a cell is about 8 by 17 pixels.

## Develop

```sh
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```
