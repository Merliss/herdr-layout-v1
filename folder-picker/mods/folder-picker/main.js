// Quick access to the folder we work in: a panel of folders from open spaces
// plus a few recent ones. Ctrl+Shift+G opens the mod, which opens the native
// folder picker; picking any folder starts a new space there.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { checking, closeOverlay, pickFolder, props, run, setShared, shared, spaces, theme } from "herdr";

const RECENT = "folder-picker.recent";
const LIMIT = 6;

function recent() {
  const value = shared(RECENT);
  return Array.isArray(value) ? value : [];
}

function short(folder) {
  const parts = folder.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  return parts.pop() || folder;
}

function remember(folder, machine) {
  const kept = recent().filter(r => !(r?.folder === folder && (r?.machine ?? null) === machine));
  setShared(RECENT, [{ folder, machine }, ...kept].slice(0, LIMIT));
}

function start(folder, machine) {
  if (!folder) return;
  const overlay = props().overlay;
  if (overlay) closeOverlay(overlay);
  remember(folder, machine ?? null);
  run("space.new", { folder, machine: machine ?? "" });
}

export default class FolderPicker extends View {
  init(_props, cx) {
    // Opened as an overlay by Ctrl+Shift+G: go straight to the folder picker.
    // A check runs init for real, so never open a dialog there.
    if (!checking() && props().overlay) this.browse(cx);
  }

  browse(cx) {
    cx.spawn(async (cx) => {
      try {
        const folder = await pickFolder({ prompt: "Wybierz folder roboczy" });
        if (folder) start(folder, null);
      } catch {
        // A cancelled or failed picker leaves the current space alone.
      }
    });
  }

  rows() {
    const seen = new Set();
    const rows = [];
    const add = (folder, machine, name) => {
      if (!folder) return;
      const key = `${machine ?? ""}\u0000${folder}`;
      if (seen.has(key)) return;
      seen.add(key);
      rows.push({ folder, machine: machine ?? null, name: name || short(folder) });
    };
    for (const s of spaces()) add(s.folder, s.machine, s.name);
    for (const r of recent()) add(r?.folder, r?.machine, short(r?.folder ?? ""));
    return rows;
  }

  render() {
    const t = theme();
    return v_flex().id("folder-picker").h_full().w_full().bg(t.chrome).p(8).gap(4).text_size(12)
      .child(h_flex().items_center().justify_between().px(2).pb(3)
        .child(div().text_color(t.muted).child("FOLDER"))
        .child(div().text_size(10).text_color(t.dim).child("Ctrl+Shift+G")))
      .child(h_flex().id("browse").h(30).px(9).gap(8).items_center().rounded(6)
        .hover(s => s.bg(t.selected)).on_click((_e, cx) => this.browse(cx))
        .child(div().child("+"))
        .child(div().child("Przeglądaj…")))
      .child(div().h(1).bg(t.border))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar()
        .children(this.rows().map(r =>
          h_flex().id(`f-${r.folder}-${r.machine ?? ""}`).h(34).px(9).gap(6).items_center().rounded(6)
            .hover(s => s.bg(t.raised)).on_click(() => start(r.folder, r.machine))
            .child(v_flex().flex_1()
              .child(div().text_color(t.foreground).truncate().child(r.name))
              .child(div().text_size(10).text_color(t.dim).truncate().child(r.folder)))
            .when(Boolean(r.machine), el => el.child(div().text_size(10).text_color(t.dim).child(r.machine))))))
  }
}
