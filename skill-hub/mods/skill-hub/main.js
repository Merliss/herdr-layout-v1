import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, Editor, EditorState } from "gpui-base";
import {
  home,
  readTextFile,
  writeTextFile,
  theme,
  settings,
  props,
  closeOverlay,
  hc,
  exec,
  notify,
  focused,
  window,
  shared,
  setShared,
} from "herdr";

const HUB_CATEGORIES = [
  { id: "all", label: "Wszystkie" },
  { id: "pstack", label: "⚡ pstack" },
  { id: "cloudflare", label: "☁️ Cloudflare" },
  { id: "workflow", label: "Workflow" },
  { id: "ai", label: "AI" },
  { id: "frontend", label: "Frontend" },
  { id: "devops", label: "DevOps" },
  { id: "backend", label: "Backend" },
  { id: "testing", label: "Testing" },
  { id: "marketing", label: "Marketing" },
];

function parseSkill(text, id) {
  let name = id;
  let description = "";
  let content = text;

  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end !== -1) {
      const header = text.slice(3, end);
      content = text.slice(end + 4).trim();

      const nameMatch = header.match(/^\s*name:\s*(.+)$/m);
      if (nameMatch) {
        name = nameMatch[1].trim().replace(/^['"]|['"]$/g, "");
      }

      const descMatch = header.match(/^\s*description:\s*(?:>|\|)?\s*\n?([\s\S]*?)(?=\n\w+:|$)/m);
      if (descMatch) {
        description = descMatch[1]
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .join(" ")
          .replace(/^['"]|['"]$/g, "");
      }
    }
  }

  if (!description) {
    const lines = content.split("\n").map((l) => l.trim());
    for (const line of lines) {
      if (line && !line.startsWith("#") && !line.startsWith("---") && !line.startsWith("```")) {
        description = line;
        break;
      }
    }
  }

  const shortDescription = getShortDescription(description);

  return { name: name || id, description, shortDescription, content };
}

function getShortDescription(desc) {
  if (!desc) return "Brak opisu.";
  const clean = desc.replace(/[*_`]/g, "").trim();
  const match = clean.match(/^(.+?[.!?])(?:\s|$)/);
  if (match && match[1].length >= 15 && match[1].length <= 160) {
    return match[1].trim();
  }
  if (clean.length > 130) {
    return clean.slice(0, 127).trim() + "…";
  }
  return clean;
}

function parseDiffLines(lines) {
  let oldNum = 0, nextNum = 0;
  const maxLines = 350;
  const total = lines.length;
  const slice = lines.slice(0, maxLines);

  const rows = slice.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) {
      oldNum = parseInt(match[1], 10);
      nextNum = parseInt(match[2], 10);
      return { kind: "@", text: line };
    }
    if (
      line.startsWith("---") ||
      line.startsWith("+++") ||
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("warning:")
    ) {
      return { kind: "h", text: line };
    }
    const firstChar = line[0];
    if (firstChar === "-") {
      return { kind: "-", number: oldNum++, text: line.slice(1) || " " };
    }
    if (firstChar === "+") {
      return { kind: "+", number: nextNum++, text: line.slice(1) || " " };
    }
    if (firstChar === " ") {
      oldNum++;
      nextNum++;
      return { kind: " ", number: nextNum, text: line.slice(1) || " " };
    }
    return { kind: "", text: line };
  });

  if (total > maxLines) {
    rows.push({
      kind: "@",
      text: `… i kolejne ${total - maxLines} wierszy zmian (skrócono podgląd dla płynności interfejsu) …`,
    });
  }
  return rows;
}

function formatStars(num) {
  if (typeof num !== "number") return null;
  if (num >= 1000000) return (num / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
  if (num >= 1000) return (num / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(num);
}

function countDiffStats(lines) {
  let add = 0, del = 0;
  for (const l of lines) {
    if (l.startsWith("+") && !l.startsWith("+++")) add++;
    else if (l.startsWith("-") && !l.startsWith("---")) del++;
  }
  return { add, del };
}

export default class SkillsMod extends View {
  init(_props, cx) {
    const t = theme();
    this.mainTab = "installed"; // "installed" | "hub"
    this.skills = [];
    this.selected = null;
    this.loading = true;
    this.error = null;
    this.filter = "";
    this.scopeFilter = "active"; // "active" | "hidden" | "all"
    this.isEditing = false;
    this.deletingId = null;
    this.showFullDesc = false;

    // Hub State
    this.hubSkills = [];
    this.hubCategory = "all";
    this.selectedHubSkill = null;
    this.installingSkillName = null;
    this.hubSort = "stars"; // "stars" | "name"
    this.installedSort = "name"; // "name" | "stars"
    // Rendering hundreds of rows in one pass exceeds the shell's 2 s render budget.
    this.hubPageSize = 60;
    this.hubVisibleCount = this.hubPageSize;

    // GitHub Stats State
    this.githubStats = {}; // repoKey (e.g. "anthropics/skills") -> { stars, forks, openIssues, pushedAt, license }

    // Update & Diff State
    this.checkingUpdates = false;
    this.pendingDiff = null; // { skillId, rows, stats, type, sourceName, tempFile }
    this.skillsUpdates = new Map(); // skillId -> updateData

    // Load hidden skill ids from shared / localStorage
    let savedHidden = [];
    try {
      savedHidden = shared("skills.hidden") || JSON.parse(localStorage.getItem("skills.hidden") || "[]");
    } catch {}
    this.hiddenSkills = new Set(Array.isArray(savedHidden) ? savedHidden : []);

    this.searchInput = InputState.new({ placeholder: "Szukaj w zainstalowanych lub katalogu Hub…" });
    this.searchInput.on("change", (_e, cx) => {
      this.filter = (this.searchInput.value() || "").trim();
      if (this.mainTab === "installed") {
        this.syncSelection();
      } else {
        this.hubVisibleCount = this.hubPageSize;
        this.syncHubSelection();
      }
      cx.notify();
    });

    this.code = EditorState.new({
      language: "markdown",
      readonly: true,
      value: "Ładowanie skilli…",
      font_family: settings().font_family,
      font_size: 12,
      syntax: {
        keyword: t.ansi5,
        string: t.ansi2,
        comment: t.dim,
        function: t.ansi4,
        type: t.ansi3,
        number: t.ansi1,
        constant: t.ansi6,
      },
    });

    this.handle = cx.focus_handle();
    this.searchInput.focus();

    this.load(cx);
  }

  async close(_cx) {
    this.code?.release();
  }

  saveHidden() {
    const arr = Array.from(this.hiddenSkills);
    try {
      localStorage.setItem("skills.hidden", JSON.stringify(arr));
      setShared("skills.hidden", arr);
    } catch {}
  }

  toggleHidden(skill, cx) {
    if (this.hiddenSkills.has(skill.id)) {
      this.hiddenSkills.delete(skill.id);
      notify({ title: "Skill przywrócony", body: `"${skill.name}" jest teraz aktywny`, level: "done" });
    } else {
      this.hiddenSkills.add(skill.id);
      notify({ title: "Skill ukryty", body: `"${skill.name}" przeniesiono do ukrytych`, level: "info" });
    }
    this.saveHidden();
    this.syncSelection();
    if (cx) cx.notify();
  }

  recreateEditor(skill, readonly) {
    const t = theme();
    this.code?.release();
    this.code = EditorState.new({
      language: "markdown",
      readonly: readonly,
      value: skill ? skill.content : "",
      font_family: settings().font_family,
      font_size: 12,
      syntax: {
        keyword: t.ansi5,
        string: t.ansi2,
        comment: t.dim,
        function: t.ansi4,
        type: t.ansi3,
        number: t.ansi1,
        constant: t.ansi6,
      },
    });
  }

  syncSelection() {
    const filtered = this.filteredSkills();
    if (filtered.length === 0) {
      this.selected = null;
      this.pendingDiff = null;
      this.code?.set_value("");
      return;
    }
    const stillMatches = filtered.find((s) => s.id === this.selected?.id);
    const next = stillMatches || filtered[0];
    this.selectSkill(next);
  }

  selectSkill(skill) {
    this.selected = skill;
    this.deletingId = null;
    this.showFullDesc = false;
    this.isEditing = false;
    this.pendingDiff = this.skillsUpdates.get(skill?.id) || null;
    if (skill) {
      this.code?.set_value(skill.content || `# ${skill.name}\n\n${skill.description}`);
    } else {
      this.code?.set_value("");
    }
  }

  syncHubSelection() {
    const filtered = this.filteredHubSkills();
    if (filtered.length === 0) {
      this.selectedHubSkill = null;
      return;
    }
    const still = filtered.find((s) => s.name === this.selectedHubSkill?.name);
    this.selectedHubSkill = still || filtered[0];
  }

  isSkillInstalled(name) {
    if (!name) return false;
    const lower = name.toLowerCase().trim();
    return this.skills.some((s) => s.id.toLowerCase() === lower || s.name.toLowerCase() === lower);
  }

  goToInstalledSkill(name, cx) {
    const lower = name.toLowerCase().trim();
    const found = this.skills.find((s) => s.id.toLowerCase() === lower || s.name.toLowerCase() === lower);
    if (found) {
      this.mainTab = "installed";
      this.selectSkill(found);
      if (cx) cx.notify();
    }
  }

  load(cx) {
    this.loading = true;
    this.error = null;
    this.deletingId = null;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const isWin = window()?.platform === "windows";
        const h = home();

        // 1. Read .skill-lock.json if available
        let lockMap = {};
        try {
          const lockRaw = await readTextFile(`${h}/.agents/.skill-lock.json`.replace(/\\/g, "/"));
          if (lockRaw) {
            const parsedLock = JSON.parse(lockRaw);
            lockMap = parsedLock.skills || {};
          }
        } catch {}

        // 2. Read skillshare-hub.json
        try {
          const hubPath = `${h}/.agents/skills/skillshare-hub/skillshare-hub.json`.replace(/\\/g, "/");
          const hubRaw = await readTextFile(hubPath);
          if (hubRaw) {
            const parsedHub = JSON.parse(hubRaw);
            this.hubSkills = Array.isArray(parsedHub.skills) ? parsedHub.skills : [];
          }
        } catch (e) {
          console.error("Failed to load skillshare-hub.json:", e);
        }
        if (!this.hubSkills.length) {
          try {
            const bundled = `${h}/.config/herdr-app/mods/skill-hub/skillshare-hub.json`.replace(/\\/g, "/");
            const raw = await readTextFile(bundled);
            if (raw) {
              const parsed = JSON.parse(raw);
              this.hubSkills = Array.isArray(parsed.skills) ? parsed.skills : [];
            }
          } catch {}
        }

        // 2b. Read github-stats.json (stars, forks, open issues, license)
        try {
          const statsPath = `${h}/.agents/skills/skillshare-hub/github-stats.json`.replace(/\\/g, "/");
          const statsRaw = await readTextFile(statsPath);
          if (statsRaw) {
            this.githubStats = JSON.parse(statsRaw);
          }
        } catch (e) {
          try {
            const fallbackPath = `${h}/.config/herdr-app/mods/skill-hub/github-stats.json`.replace(/\\/g, "/");
            const fallbackRaw = await readTextFile(fallbackPath);
            if (fallbackRaw) {
              this.githubStats = JSON.parse(fallbackRaw);
            }
          } catch {}
        }

        // 3. Scan installed skills
        let rawList = [];
        if (isWin) {
          const r = await exec("powershell", [
            "-NoProfile",
            "-Command",
            `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $dir = [IO.Path]::Combine($env:USERPROFILE, '.agents', 'skills'); if (Test-Path -LiteralPath $dir) { @(Get-ChildItem -LiteralPath $dir -Directory | ForEach-Object { $p = $_.FullName; $hasSkill = Test-Path -LiteralPath (Join-Path $p 'SKILL.md'); $hasGit = Test-Path -LiteralPath (Join-Path $p '.git'); if ($hasSkill) { @{ id=$_.Name; path=$p.Replace('\\','/'); hasGit=[bool]$hasGit } } }) | ConvertTo-Json -Compress } else { '[]' }`,
          ]);
          if (r.code === 0 && r.stdout) {
            try {
              const parsed = JSON.parse(r.stdout.trim());
              rawList = Array.isArray(parsed) ? parsed : [parsed];
            } catch (e) {
              console.error("Failed to parse skills list JSON:", e);
            }
          }
        } else {
          const r = await exec("sh", [
            "-c",
            'for d in "$HOME"/.agents/skills/*; do [ -f "$d/SKILL.md" ] && printf "%s\t%s\t%d\n" "${d##*/}" "$d" "$([ -d "$d/.git" ] && echo 1 || echo 0)"; done',
          ]).catch(() => null);
          if (r && r.code === 0 && r.stdout) {
            const lines = r.stdout.split("\n").filter(Boolean);
            for (const line of lines) {
              const [id, path, gitVal] = line.split("\t");
              if (id && path) {
                rawList.push({ id, path, hasGit: gitVal === "1" });
              }
            }
          }
        }

        const loaded = [];
        for (const item of rawList) {
          const skillMd = `${item.path}/SKILL.md`;
          const text = await readTextFile(skillMd).catch(() => null);
          if (!text) continue;

          const parsed = parseSkill(text, item.id);
          const lockEntry = lockMap[item.id] || null;

          loaded.push({
            id: item.id,
            name: parsed.name,
            description: parsed.description,
            shortDescription: parsed.shortDescription,
            content: parsed.content,
            path: item.path,
            hasGit: Boolean(item.hasGit),
            lockInfo: lockEntry,
          });
        }

        loaded.sort((a, b) => a.name.localeCompare(b.name));
        this.skills = loaded;
      } catch (err) {
        this.error = String(err?.message || err);
      } finally {
        this.loading = false;
        if (this.mainTab === "installed") {
          this.syncSelection();
        } else {
          this.syncHubSelection();
        }
      }
      cx.notify();
    });
  }

  getSkillStats(sourceOrName) {
    if (!sourceOrName || !this.githubStats) return null;
    const lower = sourceOrName.toLowerCase();

    // Direct repo or owner/repo/skill
    const parts = lower.split("/");
    if (parts.length >= 2) {
      const repoKey = `${parts[0]}/${parts[1]}`;
      if (this.githubStats[repoKey]) {
        return { stats: this.githubStats[repoKey], repo: repoKey };
      }
    }

    // Match by Hub skill name
    const hubMatch = this.hubSkills.find((h) => h.name && h.name.toLowerCase() === lower);
    if (hubMatch && hubMatch.source) {
      const hParts = hubMatch.source.toLowerCase().split("/");
      if (hParts.length >= 2) {
        const repoKey = `${hParts[0]}/${hParts[1]}`;
        if (this.githubStats[repoKey]) {
          return { stats: this.githubStats[repoKey], repo: repoKey };
        }
      }
    }

    // Match known installed skill families
    if (lower.includes("matt")) {
      return { stats: this.githubStats["mattpocock/skills"], repo: "mattpocock/skills" };
    }
    if (lower.includes("playwright")) {
      return { stats: this.githubStats["testdino-hq/playwright-skill"], repo: "testdino-hq/playwright-skill" };
    }
    if (lower === "skillshare-hub") {
      return { stats: this.githubStats["runkids/skillshare-hub"], repo: "runkids/skillshare-hub" };
    }
    if (lower === "skillshare") {
      return { stats: this.githubStats["runkids/skillshare"], repo: "runkids/skillshare" };
    }
    if (
      lower.includes("poteto") ||
      lower.includes("pstack") ||
      lower.startsWith("principle-") ||
      lower === "architect" ||
      lower === "swarm" ||
      lower === "unslop" ||
      lower === "statechart" ||
      lower === "show-me-your-work"
    ) {
      return { stats: this.githubStats["backnotprop/pstack"], repo: "backnotprop/pstack" };
    }
    if (
      lower.includes("cloudflare") ||
      lower.includes("workers-") ||
      lower === "durable-objects" ||
      lower === "wrangler" ||
      lower === "turnstile-spin"
    ) {
      return { stats: this.githubStats["cloudflare/skills"], repo: "cloudflare/skills" };
    }
    if (
      lower.includes("superpower") ||
      lower.includes("arena") ||
      lower.includes("benchmark") ||
      lower.includes("interrogate") ||
      lower.includes("ponytail")
    ) {
      return { stats: this.githubStats["obra/superpowers"], repo: "obra/superpowers" };
    }
    if (lower.includes("agent-browser")) {
      return { stats: this.githubStats["vercel-labs/agent-browser"], repo: "vercel-labs/agent-browser" };
    }
    if (lower.includes("ui-ux-pro-max")) {
      return { stats: this.githubStats["nextlevelbuilder/ui-ux-pro-max-skill"], repo: "nextlevelbuilder/ui-ux-pro-max-skill" };
    }
    if (lower.includes("caveman")) {
      return { stats: this.githubStats["juliusbrussee/caveman"], repo: "juliusbrussee/caveman" };
    }
    if (lower.includes("hyperframes")) {
      return { stats: this.githubStats["heygen-com/hyperframes"], repo: "heygen-com/hyperframes" };
    }

    return null;
  }

  renderGitHubStatsBox(t, statsInfo) {
    if (!statsInfo || !statsInfo.stats) return null;
    const { stats, repo } = statsInfo;
    const starsFull = typeof stats.stars === "number" ? stats.stars.toLocaleString() : "—";
    const forksFull = typeof stats.forks === "number" ? stats.forks.toLocaleString() : "—";
    const issuesFull = typeof stats.openIssues === "number" ? stats.openIssues.toLocaleString() : "—";
    const licenseName = stats.license || "Brak info";
    const pushedAt = stats.pushedAt ? stats.pushedAt.split("T")[0] : null;

    return v_flex()
      .mx(12)
      .mb(12)
      .p(12)
      .rounded(8)
      .bg(t.surface)
      .border_1()
      .border_color(t.border)
      .gap(10)
      .child(
        h_flex()
          .justify_between()
          .items_center()
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(div().text_size(12).font_bold().text_color(t.ansi3 || "#e3b341").child("★"))
              .child(div().text_size(11).font_bold().text_color(t.dim).child("STATYSTYKI GITHUB REPOZYTORIUM"))
          )
          .when(Boolean(repo), (el) =>
            el.child(
              div()
                .text_size(11)
                .font_semibold()
                .text_color(t.accent)
                .child(repo)
            )
          )
      )
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(
            // Stars
            v_flex()
              .flex_1()
              .p(8)
              .rounded(6)
              .bg(t.background)
              .border_1()
              .border_color(t.border)
              .gap(2)
              .child(div().text_size(10).font_medium().text_color(t.dim).child("⭐ Gwiazdki"))
              .child(div().text_size(15).font_bold().text_color(t.ansi3 || "#e3b341").child(starsFull))
          )
          .child(
            // Forks
            v_flex()
              .flex_1()
              .p(8)
              .rounded(6)
              .bg(t.background)
              .border_1()
              .border_color(t.border)
              .gap(2)
              .child(div().text_size(10).font_medium().text_color(t.dim).child("🍴 Forki"))
              .child(div().text_size(15).font_bold().text_color(t.foreground).child(forksFull))
          )
          .child(
            // Issues
            v_flex()
              .flex_1()
              .p(8)
              .rounded(6)
              .bg(t.background)
              .border_1()
              .border_color(t.border)
              .gap(2)
              .child(div().text_size(10).font_medium().text_color(t.dim).child("⚠️ Zgłoszenia"))
              .child(div().text_size(15).font_bold().text_color(t.foreground).child(issuesFull))
          )
          .child(
            // License
            v_flex()
              .flex_1()
              .p(8)
              .rounded(6)
              .bg(t.background)
              .border_1()
              .border_color(t.border)
              .gap(2)
              .child(div().text_size(10).font_medium().text_color(t.dim).child("📜 Licencja"))
              .child(div().text_size(13).font_bold().truncate().text_color(t.foreground).child(licenseName))
          )
      )
      .when(Boolean(pushedAt), (el) =>
        el.child(
          h_flex()
            .gap(6)
            .items_center()
            .text_size(11)
            .text_color(t.dim)
            .child(div().child("🕒 Ostatnia aktywność (push):"))
            .child(div().font_semibold().text_color(t.foreground).child(pushedAt))
        )
      );
  }

  filteredSkills() {
    const q = (this.filter || "").toLowerCase().trim();
    let list = this.skills;

    if (this.scopeFilter === "active") {
      list = list.filter((s) => !this.hiddenSkills.has(s.id));
    } else if (this.scopeFilter === "hidden") {
      list = list.filter((s) => this.hiddenSkills.has(s.id));
    }

    if (q) {
      list = list.filter((s) => {
        return (
          s.name.toLowerCase().includes(q) ||
          s.id.toLowerCase().includes(q) ||
          (s.description && s.description.toLowerCase().includes(q))
        );
      });
    }

    if (this.installedSort === "stars") {
      return [...list].sort((a, b) => {
        const sA = this.getSkillStats(a.id)?.stats?.stars || 0;
        const sB = this.getSkillStats(b.id)?.stats?.stars || 0;
        if (sB !== sA) return sB - sA;
        return a.name.localeCompare(b.name);
      });
    }

    return list;
  }

  filteredHubSkills() {
    const q = (this.filter || "").toLowerCase().trim();
    let list = this.hubSkills;

    if (this.hubCategory !== "all") {
      list = list.filter((s) => Array.isArray(s.tags) && s.tags.includes(this.hubCategory));
    }

    if (q) {
      list = list.filter((s) => {
        const matchName = s.name && s.name.toLowerCase().includes(q);
        const matchDesc = s.description && s.description.toLowerCase().includes(q);
        const matchSource = s.source && s.source.toLowerCase().includes(q);
        const matchTags = Array.isArray(s.tags) && s.tags.some((t) => t.toLowerCase().includes(q));
        return matchName || matchDesc || matchSource || matchTags;
      });
    }

    return [...list].sort((a, b) => {
      if (this.hubSort === "stars") {
        const sA = this.getSkillStats(a.source)?.stats?.stars || 0;
        const sB = this.getSkillStats(b.source)?.stats?.stars || 0;
        if (sB !== sA) return sB - sA;
      }
      return (a.name || "").localeCompare(b.name || "");
    });
  }

  async installHubSkill(hubSkill, cx) {
    if (!hubSkill) return;
    this.installingSkillName = hubSkill.name;
    notify({
      title: "Instalowanie…",
      body: `Pobieram "${hubSkill.name}" z ${hubSkill.source}`,
      level: "info",
    });
    cx.notify();

    try {
      const parts = hubSkill.source.split("/");
      let cmd = "";
      if (parts.length >= 3) {
        const repo = `${parts[0]}/${parts[1]}`;
        const skillName = parts.slice(2).join("/");
        cmd = `npx -y skills add ${repo} --skill ${skillName} -g -y`;
      } else {
        cmd = `npx -y skills add ${hubSkill.source} -g -y`;
      }

      const res = await exec("cmd.exe", ["/c", cmd]);
      if (res.code === 0) {
        notify({
          title: "Zainstalowano skill!",
          body: `"${hubSkill.name}" został dodany do ~/.agents/skills`,
          level: "done",
        });
        this.load(cx);
      } else {
        throw new Error(res.stderr || res.stdout || "Błąd instalacji");
      }
    } catch (err) {
      const raw = String(err?.message || err);
      const lower = raw.toLowerCase();
      let body = raw;
      if (
        lower.includes("ca-bundle") ||
        lower.includes("trust anchor") ||
        lower.includes("certificate") ||
        lower.includes("unable to access") ||
        lower.includes("ssl")
      ) {
        body =
          "Git nie może zweryfikować certyfikatu GitHuba na tym komputerze.\n\n" +
          "W PowerShell uruchom:\n" +
          "  git config --global http.sslBackend schannel\n" +
          "  git config --global --unset-all http.sslCAInfo\n\n" +
          "Sprawdź: git ls-remote https://github.com/mattpocock/skills.git\n" +
          "Jeśli nadal nie działa — zainstaluj ponownie Git for Windows.\n\n" +
          "Oryginalny błąd: " + raw.slice(0, 300);
      }
      notify({
        title: "Błąd instalacji",
        body,
        level: "error",
      });
    } finally {
      this.installingSkillName = null;
      cx.notify();
    }
  }

  openHubUrl(hubSkill) {
    const parts = hubSkill.source.split("/");
    const repo = `${parts[0]}/${parts[1]}`;
    const url = `https://github.com/${repo}`;
    const isWin = window()?.platform === "windows";
    if (isWin) {
      exec("cmd.exe", ["/c", `start ${url}`]).catch(() => {});
    } else {
      exec("open", [url]).catch(() => exec("xdg-open", [url]).catch(() => {}));
    }
  }

  copyInstallCommand(hubSkill, cx) {
    const parts = hubSkill.source.split("/");
    let cmd = "";
    if (parts.length >= 3) {
      cmd = `npx skills add ${parts[0]}/${parts[1]} --skill ${parts.slice(2).join("/")} -g`;
    } else {
      cmd = `npx skills add ${hubSkill.source} -g`;
    }
    try {
      cx.write_to_clipboard(cmd);
      notify({ title: "Skopiowano polecenie", body: cmd, level: "done" });
    } catch (e) {
      notify({ title: "Błąd kopiowania", body: String(e), level: "error" });
    }
  }

  async checkSkillUpdate(skill, cx) {
    if (!skill) return;
    this.checkingUpdates = true;
    notify({ title: "Sprawdzanie…", body: `Szukam zmian dla "${skill.name}"`, level: "info" });
    cx.notify();

    try {
      if (skill.hasGit) {
        await exec("git", ["-C", skill.path, "fetch", "origin"]);
        const diffRes = await exec("git", ["-C", skill.path, "diff", "HEAD..origin/main"]);
        if (diffRes.code === 0 && diffRes.stdout.trim()) {
          const lines = diffRes.stdout.split("\n");
          const rows = parseDiffLines(lines);
          const stats = countDiffStats(lines);
          const updateData = {
            skillId: skill.id,
            rows,
            stats,
            type: "git",
            sourceName: "Git (origin/main)",
          };
          this.skillsUpdates.set(skill.id, updateData);
          this.pendingDiff = updateData;
          notify({
            title: "Dostępna aktualizacja!",
            body: `Znaleziono zmiany (+${stats.add} / -${stats.del}) dla "${skill.name}"`,
            level: "done",
          });
        } else {
          this.skillsUpdates.delete(skill.id);
          this.pendingDiff = null;
          notify({
            title: "Skill jest aktualny",
            body: `"${skill.name}" jest w najnowszej wersji.`,
            level: "done",
          });
        }
      } else if (skill.lockInfo && skill.lockInfo.sourceType === "github") {
        const isWin = window()?.platform === "windows";
        const h = home();
        const rawUrl = `https://raw.githubusercontent.com/${skill.lockInfo.source}/main/${skill.lockInfo.skillPath}`;
        const tempPath = isWin
          ? `${h}/AppData/Local/Temp/skill-diff-${skill.id}.tmp`.replace(/\//g, "\\")
          : `/tmp/skill-diff-${skill.id}.tmp`;
        const localPath = `${skill.path}/SKILL.md`.replace(/\//g, isWin ? "\\" : "/");

        const curlRes = await exec("curl.exe", ["-s", "-f", rawUrl, "-o", tempPath]);
        if (curlRes.code === 0) {
          const diffRes = await exec("git", ["diff", "--no-index", localPath, tempPath]);
          if (diffRes.stdout && diffRes.stdout.trim()) {
            const lines = diffRes.stdout.split("\n");
            const rows = parseDiffLines(lines);
            const stats = countDiffStats(lines);
            const updateData = {
              skillId: skill.id,
              rows,
              stats,
              type: "skills-cli",
              sourceName: skill.lockInfo.source,
              tempFile: tempPath,
            };
            this.skillsUpdates.set(skill.id, updateData);
            this.pendingDiff = updateData;
            notify({
              title: "Dostępna aktualizacja!",
              body: `Znaleziono zmiany (+${stats.add} / -${stats.del}) z ${skill.lockInfo.source}`,
              level: "done",
            });
          } else {
            this.skillsUpdates.delete(skill.id);
            this.pendingDiff = null;
            notify({
              title: "Skill jest aktualny",
              body: `"${skill.name}" jest w najnowszej wersji (${skill.lockInfo.source})`,
              level: "done",
            });
            if (isWin) {
              await exec("powershell", ["-NoProfile", "-Command", `Remove-Item -Force '${tempPath.replace(/'/g, "''")}'`]).catch(() => {});
            }
          }
        } else {
          notify({
            title: "Błąd sprawdzania",
            body: `Nie udało się pobrać wersji z ${skill.lockInfo.source}`,
            level: "error",
          });
        }
      } else {
        notify({
          title: "Brak repozytorium upstream",
          body: `"${skill.name}" jest skillem lokalnym bez wpisu w lockfile lub git.`,
          level: "info",
        });
      }
    } catch (err) {
      notify({ title: "Błąd sprawdzania", body: String(err?.message || err), level: "error" });
    } finally {
      this.checkingUpdates = false;
      cx.notify();
    }
  }

  checkAllUpdates(cx) {
    if (this.checkingUpdates) return;
    this.checkingUpdates = true;
    notify({ title: "Szukanie aktualizacji…", body: "Sprawdzam źródła Git i paczki z lockfile", level: "info" });
    cx.notify();

    cx.spawn(async (cx) => {
      let foundCount = 0;
      for (const skill of this.skills) {
        if (skill.hasGit) {
          try {
            await exec("git", ["-C", skill.path, "fetch", "origin"]);
            const diffRes = await exec("git", ["-C", skill.path, "diff", "HEAD..origin/main"]);
            if (diffRes.code === 0 && diffRes.stdout.trim()) {
              const diffLines = diffRes.stdout.split("\n");
              const rows = parseDiffLines(diffLines);
              const stats = countDiffStats(diffLines);
              this.skillsUpdates.set(skill.id, {
                skillId: skill.id,
                rows,
                stats,
                type: "git",
                sourceName: "Git (origin/main)",
              });
              foundCount++;
            }
          } catch {}
        } else if (skill.lockInfo && skill.lockInfo.sourceType === "github") {
          try {
            const isWin = window()?.platform === "windows";
            const h = home();
            const rawUrl = `https://raw.githubusercontent.com/${skill.lockInfo.source}/main/${skill.lockInfo.skillPath}`;
            const tempPath = isWin
              ? `${h}/AppData/Local/Temp/skill-diff-${skill.id}.tmp`.replace(/\//g, "\\")
              : `/tmp/skill-diff-${skill.id}.tmp`;
            const localPath = `${skill.path}/SKILL.md`.replace(/\//g, isWin ? "\\" : "/");
            const curlRes = await exec("curl.exe", ["-s", "-f", rawUrl, "-o", tempPath]);
            if (curlRes.code === 0) {
              const diffRes = await exec("git", ["diff", "--no-index", localPath, tempPath]);
              if (diffRes.stdout && diffRes.stdout.trim()) {
                const diffLines = diffRes.stdout.split("\n");
                const rows = parseDiffLines(diffLines);
                const stats = countDiffStats(diffLines);
                this.skillsUpdates.set(skill.id, {
                  skillId: skill.id,
                  rows,
                  stats,
                  type: "skills-cli",
                  sourceName: skill.lockInfo.source,
                  tempFile: tempPath,
                });
                foundCount++;
              }
            }
          } catch {}
        }
      }
      this.checkingUpdates = false;
      if (this.selected && this.skillsUpdates.has(this.selected.id)) {
        this.pendingDiff = this.skillsUpdates.get(this.selected.id);
      }
      notify({
        title: "Koniec sprawdzania",
        body: foundCount > 0 ? `Znaleziono aktualizacje dla ${foundCount} skilli!` : "Wszystkie skille są aktualne.",
        level: foundCount > 0 ? "done" : "info",
      });
      cx.notify();
    });
  }

  async applyUpdate(skill, cx) {
    const update = this.pendingDiff || this.skillsUpdates.get(skill.id);
    if (!update) return;

    notify({ title: "Aktualizowanie…", body: `Stosuję aktualizację dla "${skill.name}"`, level: "info" });

    try {
      if (update.type === "git") {
        const pullRes = await exec("git", ["-C", skill.path, "pull", "--rebase", "--autostash"]);
        if (pullRes.code === 0) {
          notify({ title: "Zaktualizowano!", body: `"${skill.name}" został zaktualizowany`, level: "done" });
        } else {
          throw new Error(pullRes.stderr || "Git pull nie powiódł się");
        }
      } else if (update.type === "skills-cli") {
        if (update.tempFile) {
          const newText = await readTextFile(update.tempFile);
          if (newText) {
            const target = `${skill.path}/SKILL.md`.replace(/\\/g, "/");
            const current = await readTextFile(target);
            await writeTextFile(target, newText, current);
          }
        }
        exec("cmd.exe", ["/c", `npx -y skills update -g -y ${skill.id}`]).catch(() => {});
        notify({ title: "Zaktualizowano!", body: `"${skill.name}" zaktualizowany z ${update.sourceName}`, level: "done" });
      }

      this.pendingDiff = null;
      this.skillsUpdates.delete(skill.id);

      // Reload content in view
      const text = await readTextFile(`${skill.path}/SKILL.md`);
      if (text) {
        const parsed = parseSkill(text, skill.id);
        skill.name = parsed.name;
        skill.description = parsed.description;
        skill.shortDescription = parsed.shortDescription;
        skill.content = parsed.content;
        this.code?.set_value(parsed.content);
      }
    } catch (err) {
      notify({ title: "Błąd aktualizacji", body: String(err?.message || err), level: "error" });
    } finally {
      cx.notify();
    }
  }

  copyPrompt(skill, cx) {
    const promptText = `Use the ${skill.name} skill: ${skill.description}`;
    try {
      cx.write_to_clipboard(promptText);
      notify({
        title: "Prompt skopiowany!",
        body: `Skopiowano prompt dla "${skill.name}" do schowka`,
        level: "done",
      });
    } catch (e) {
      notify({ title: "Błąd kopiowania", body: String(e), level: "error" });
    }
  }

  copyName(skill, cx) {
    try {
      cx.write_to_clipboard(skill.name);
      notify({
        title: "Nazwa skopiowana!",
        body: `"${skill.name}" skopiowano do schowka`,
        level: "done",
      });
    } catch (e) {
      notify({ title: "Błąd kopiowania", body: String(e), level: "error" });
    }
  }

  async sendToTerminal(skill, cx) {
    const f = focused();
    if (!f || !f.terminal) {
      notify({
        title: "Brak aktywnego terminala",
        body: "Najpierw zaznacz panel z terminalem.",
        level: "warn",
      });
      return;
    }
    const text = `Use ${skill.name} skill to \n`;
    try {
      await hc(["send", f.terminal, text]);
      notify({
        title: "Wysłano do terminala",
        body: `Przekazano prompt do terminala ${f.terminal}`,
        level: "done",
      });
      const ov = props()?.overlay;
      if (ov) closeOverlay(ov);
    } catch (e) {
      notify({ title: "Błąd wysyłania", body: String(e), level: "error" });
    }
  }

  openFolder(skill) {
    const isWin = window()?.platform === "windows";
    const targetPath = skill.path.replace(/\//g, isWin ? "\\" : "/");
    if (isWin) {
      exec("explorer.exe", [targetPath]).catch(() => {});
    } else {
      exec("open", [targetPath]).catch(() => exec("xdg-open", [targetPath]).catch(() => {}));
    }
  }

  async saveSkillContent(skill, cx) {
    if (!this.code) return;
    const newContent = this.code.value();
    const filePath = `${skill.path}/SKILL.md`.replace(/\\/g, "/");

    try {
      const current = await readTextFile(filePath);
      await writeTextFile(filePath, newContent, current);
      notify({
        title: "Zapisano!",
        body: `Pomyślnie zaktualizowano "${skill.name}"`,
        level: "done",
      });
      const parsed = parseSkill(newContent, skill.id);
      skill.name = parsed.name;
      skill.description = parsed.description;
      skill.shortDescription = parsed.shortDescription;
      skill.content = parsed.content;
      this.isEditing = false;
      this.recreateEditor(skill, true);
      cx.notify();
    } catch (err) {
      notify({ title: "Błąd zapisu", body: String(err?.message || err), level: "error" });
    }
  }

  async deleteSkill(skill, cx) {
    this.deletingId = null;
    const isWin = window()?.platform === "windows";
    const winPath = skill.path.replace(/\//g, "\\");

    try {
      if (isWin) {
        await exec("powershell", [
          "-NoProfile",
          "-Command",
          `Remove-Item -Recurse -Force -LiteralPath '${winPath.replace(/'/g, "''")}'`,
        ]);
      } else {
        await exec("rm", ["-rf", skill.path]);
      }
      notify({
        title: "Skill usunięty",
        body: `Usunięto "${skill.name}" z ~/.agents/skills`,
        level: "done",
      });
      this.hiddenSkills.delete(skill.id);
      this.skillsUpdates.delete(skill.id);
      this.saveHidden();
      this.load(cx);
    } catch (err) {
      notify({ title: "Błąd usuwania", body: String(err?.message || err), level: "error" });
    }
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") {
      return div()
        .w_full()
        .px(10)
        .py(3)
        .flex_none()
        .truncate()
        .bg(t.raised)
        .text_size(11)
        .text_color(t.dim)
        .child(text);
    }
    if (kind === "h") {
      return div()
        .w_full()
        .px(10)
        .py(1)
        .flex_none()
        .truncate()
        .text_size(10.5)
        .text_color(t.dim)
        .child(text);
    }
    const isAdd = kind === "+";
    const isDel = kind === "-";
    return h_flex()
      .w_full()
      .min_h(20)
      .flex_none()
      .gap(8)
      .px(8)
      .text_size(11.5)
      .when(isAdd, (e) => e.bg(t.ansi2 + "18").text_color(t.ansi2))
      .when(isDel, (e) => e.bg(t.ansi1 + "18").text_color(t.ansi1))
      .when(!isAdd && !isDel, (e) => e.text_color(t.foreground))
      .child(
        div()
          .w(36)
          .flex_none()
          .text_right()
          .text_size(10.5)
          .text_color(t.dim)
          .child(number === undefined ? "" : String(number))
      )
      .child(
        div()
          .w(14)
          .flex_none()
          .text_center()
          .font_bold()
          .text_color(isAdd ? t.ansi2 : isDel ? t.ansi1 : t.dim)
          .child(kind || " ")
      )
      .child(
        div()
          .flex_1()
          .min_w(0)
          .child(text)
      );
  }

  renderDiffView(t, skill, diff) {
    return v_flex()
      .flex_1()
      .min_h(0)
      .bg(t.background)
      .child(
        // Diff Header Banner
        h_flex()
          .h(44)
          .flex_none()
          .px(16)
          .items_center()
          .justify_between()
          .bg(t.surface)
          .border_b(1)
          .border_color(t.border)
          .child(
            h_flex()
              .gap(10)
              .items_center()
              .child(div().font_bold().text_size(13).text_color(t.foreground).child(`Podgląd aktualizacji: ${skill.name}`))
              .child(
                div()
                  .px(6)
                  .py(1)
                  .rounded(4)
                  .bg(t.raised)
                  .text_size(10.5)
                  .text_color(t.dim)
                  .child(diff.sourceName)
              )
              .child(
                h_flex()
                  .gap(6)
                  .items_center()
                  .child(div().text_size(11.5).font_bold().text_color(t.ansi2).child(`+${diff.stats.add}`))
                  .child(div().text_size(11.5).font_bold().text_color(t.ansi1).child(`−${diff.stats.del}`))
              )
          )
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .child(
                h_flex()
                  .h(28)
                  .px(12)
                  .gap(4)
                  .items_center()
                  .rounded(6)
                  .bg(t.done || "#2ea043")
                  .text_color("#ffffff")
                  .text_size(12)
                  .font_semibold()
                  .cursor_pointer()
                  .hover((s) => s.opacity(0.9))
                  .on_click((_e, cx) => this.applyUpdate(skill, cx))
                  .child("✅ Zastosuj aktualizację")
              )
              .child(
                h_flex()
                  .h(28)
                  .px(10)
                  .items_center()
                  .rounded(6)
                  .bg(t.raised)
                  .border_1()
                  .border_color(t.border)
                  .text_color(t.foreground)
                  .text_size(11.5)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => {
                    this.pendingDiff = null;
                    cx.notify();
                  })
                  .child("✕ Zamknij podgląd")
              )
          )
      )
      // Diff lines list
      .child(
        v_flex()
          .id("skill-diff-list")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .p(6)
          .children(diff.rows.map((row) => this.diffRow(row, t)))
      );
  }

  renderHubDetail(t, hubSkill) {
    const isInstalled = this.isSkillInstalled(hubSkill.name);
    const isInstalling = this.installingSkillName === hubSkill.name;
    const statsInfo = this.getSkillStats(hubSkill.source);

    return v_flex()
      .flex_1()
      .min_w(0)
      .h_full()
      .min_h(0)
      .bg(t.background)
      .child(
        // Hub Skill Header
        h_flex()
          .h(58)
          .flex_none()
          .px(16)
          .gap(10)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .bg(t.surface)
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .gap(2)
              .child(
                h_flex()
                  .items_center()
                  .gap(8)
                  .child(
                    div()
                      .text_size(16)
                      .font_bold()
                      .text_color(t.foreground)
                      .truncate()
                      .child(hubSkill.name || "—")
                  )
                  .when(isInstalled, (el) =>
                    el.child(
                      div()
                        .px(6)
                        .py(1)
                        .rounded(4)
                        .bg(t.done + "22")
                        .text_size(10.5)
                        .font_semibold()
                        .text_color(t.done || "#2ea043")
                        .child("✓ Zainstalowany")
                    )
                  )
                  .child(
                    div()
                      .px(6)
                      .py(1)
                      .rounded(4)
                      .bg(t.raised)
                      .text_size(10.5)
                      .text_color(t.dim)
                      .child("Skillshare Hub")
                  )
                  .when(Boolean(statsInfo?.stats && typeof statsInfo.stats.stars === "number"), (el) =>
                    el.child(
                      div()
                        .px(6)
                        .py(1)
                        .rounded(4)
                        .bg(t.raised)
                        .border_1()
                        .border_color(t.border)
                        .text_size(10.5)
                        .font_bold()
                        .text_color(t.ansi3 || "#e3b341")
                        .child(`⭐ ${statsInfo.stats.stars.toLocaleString()} gwiazdek`)
                    )
                  )
              )
              .child(
                div()
                  .text_size(11)
                  .text_color(t.dim)
                  .truncate()
                  .child(`Source: ${hubSkill.source}`)
              )
          )
          // Action Buttons
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .when(!isInstalled, (el) =>
                el.child(
                  h_flex()
                    .h(30)
                    .px(12)
                    .gap(5)
                    .items_center()
                    .rounded(6)
                    .bg(t.solid)
                    .text_color(t.solid_foreground)
                    .text_size(12)
                    .font_semibold()
                    .cursor_pointer()
                    .hover((s) => s.opacity(0.88))
                    .on_click((_e, cx) => this.installHubSkill(hubSkill, cx))
                    .child(isInstalling ? "⏳ Instaluję…" : "📥 Zainstaluj skill")
                )
              )
              .when(isInstalled, (el) =>
                el.child(
                  h_flex()
                    .h(30)
                    .px(12)
                    .gap(5)
                    .items_center()
                    .rounded(6)
                    .bg(t.surface)
                    .border_1()
                    .border_color(t.border)
                    .text_color(t.foreground)
                    .text_size(12)
                    .font_semibold()
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover))
                    .on_click((_e, cx) => this.goToInstalledSkill(hubSkill.name, cx))
                    .child("📂 Otwórz w Zainstalowanych")
                )
              )
              .child(
                h_flex()
                  .h(30)
                  .px(10)
                  .items_center()
                  .rounded(6)
                  .bg(t.raised)
                  .border_1()
                  .border_color(t.border)
                  .text_color(t.foreground)
                  .text_size(11.5)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => this.copyInstallCommand(hubSkill, cx))
                  .child("📋 Kopiuj polecenie")
              )
              .child(
                h_flex()
                  .h(30)
                  .px(10)
                  .items_center()
                  .rounded(6)
                  .bg(t.raised)
                  .border_1()
                  .border_color(t.border)
                  .text_color(t.foreground)
                  .text_size(11.5)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .on_click(() => this.openHubUrl(hubSkill))
                  .child("GitHub ↗")
              )
          )
      )
      // Tags bar
      .when(Array.isArray(hubSkill.tags) && hubSkill.tags.length > 0, (el) =>
        el.child(
          h_flex()
            .h(36)
            .flex_none()
            .px(16)
            .gap(6)
            .items_center()
            .bg(t.chrome)
            .border_b(1)
            .border_color(t.border)
            .child(div().text_size(11).font_semibold().text_color(t.dim).child("TAGI:"))
            .children(
              hubSkill.tags.map((tag) =>
                div()
                  .px(7)
                  .py(1.5)
                  .rounded(4)
                  .bg(t.surface)
                  .border_1()
                  .border_color(t.border)
                  .text_size(10.5)
                  .text_color(t.muted)
                  .child(`#${tag}`)
              )
            )
        )
      )
      // Hub Description Box
      .child(
        v_flex()
          .m(12)
          .p(14)
          .rounded(8)
          .bg(t.surface)
          .border_1()
          .border_color(t.border)
          .gap(8)
          .child(div().text_size(11).font_bold().text_color(t.dim).child("OPIS SKILLA (Z KATALOGU HUB)"))
          .child(
            div()
              .text_size(13)
              .line_height("20px")
              .text_color(t.foreground)
              .child(hubSkill.description || "Brak szczegółowego opisu.")
          )
      )
      // GitHub Repository Statistics Box
      .when(Boolean(statsInfo?.stats), (el) =>
        el.child(this.renderGitHubStatsBox(t, statsInfo))
      )
      // Source & Installation Details Box
      .child(
        v_flex()
          .mx(12)
          .mb(12)
          .p(14)
          .rounded(8)
          .bg(t.surface)
          .border_1()
          .border_color(t.border)
          .gap(8)
          .child(div().text_size(11).font_bold().text_color(t.dim).child("INFORMACJE O ŹRÓDLE I PAKIECIE"))
          .child(
            h_flex()
              .gap(8)
              .child(div().w(90).text_size(12).text_color(t.dim).child("Repozytorium:"))
              .child(div().flex_1().text_size(12).font_semibold().text_color(t.foreground).child(hubSkill.source || "—"))
          )
          .child(
            h_flex()
              .gap(8)
              .child(div().w(90).text_size(12).text_color(t.dim).child("Instalacja CLI:"))
              .child(
                div()
                  .flex_1()
                  .font_family(settings().font_family ?? "Consolas")
                  .text_size(11.5)
                  .p(6)
                  .rounded(4)
                  .bg(t.background)
                  .border_1()
                  .border_color(t.border)
                  .text_color(t.ansi2)
                  .child(`npx skills add ${hubSkill.source} -g`)
              )
          )
      )
      .child(div().flex_1());
  }

  skillRow(item, t) {
    const isSel = this.selected && this.selected.id === item.id;
    const itemHidden = this.hiddenSkills.has(item.id);
    const hasItemUpdate = this.skillsUpdates.get(item.id);
    const itemStats = this.getSkillStats(item.id);

    return h_flex()
      .px(10)
      .py(7)
      .gap(8)
      .rounded(6)
      .items_center()
      .bg(isSel ? t.selected : t.surface)
      .text_color(isSel ? t.foreground : t.muted)
      .border_1()
      .border_color(isSel ? t.accent : t.border)
      .child(
        svg("mods/skill-hub/skills.svg")
          .size(14)
          .text_color(hasItemUpdate ? t.accent : itemHidden ? t.dim : isSel ? t.accent : t.muted)
      )
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(2)
          .child(
            h_flex()
              .items_center()
              .gap(6)
              .child(
                div()
                  .flex_1()
                  .min_w(0)
                  .text_size(12.5)
                  .font_semibold()
                  .truncate()
                  .text_color(itemHidden ? t.dim : t.foreground)
                  .child(item.name)
              )
              .when(Boolean(hasItemUpdate), (sub) =>
                sub.child(
                  div()
                    .px(4)
                    .py(0.5)
                    .rounded(3)
                    .bg(t.accent)
                    .text_size(9)
                    .font_bold()
                    .text_color("#ffffff")
                    .child(`⚡ +${hasItemUpdate.stats.add}/-${hasItemUpdate.stats.del}`)
                )
              )
              .when(itemHidden, (sub) =>
                sub.child(
                  div()
                    .px(4)
                    .py(0.5)
                    .rounded(3)
                    .bg(t.raised)
                    .text_size(9)
                    .text_color(t.dim)
                    .child("Hidden")
                )
              )
              .when(item.hasGit, (sub) =>
                sub.child(
                  div()
                    .px(4)
                    .py(0.5)
                    .rounded(3)
                    .bg(t.surface)
                    .border_1()
                    .border_color(t.border)
                    .text_size(9)
                    .text_color(t.dim)
                    .child("Git")
                )
              )
              .when(Boolean(item.lockInfo), (sub) =>
                sub.child(
                  div()
                    .px(4)
                    .py(0.5)
                    .rounded(3)
                    .bg(t.surface)
                    .border_1()
                    .border_color(t.border)
                    .text_size(9)
                    .text_color(t.dim)
                    .child(item.lockInfo.source.split("/")[0])
                )
              )
              .when(Boolean(itemStats?.stats && typeof itemStats.stats.stars === "number"), (sub) =>
                sub.child(
                  div()
                    .px(4)
                    .py(0.5)
                    .rounded(3)
                    .bg(t.raised)
                    .border_1()
                    .border_color(t.border)
                    .text_size(9)
                    .font_bold()
                    .text_color(t.ansi3 || "#e3b341")
                    .child(`★ ${formatStars(itemStats.stats.stars)}`)
                )
              )
          )
          .child(
            div()
              .text_size(10.5)
              .truncate()
              .text_color(t.dim)
              .child(item.shortDescription || "Instrukcja skilla")
          )
      );
  }

  hubRow(item, t) {
    const isSel = this.selectedHubSkill && this.selectedHubSkill.name === item.name;
    const installed = this.isSkillInstalled(item.name);
    const primaryTag = Array.isArray(item.tags) && item.tags.length > 0 ? item.tags[0] : null;
    const statsInfo = this.getSkillStats(item.source);

    return h_flex()
      .px(10)
      .py(7)
      .gap(8)
      .rounded(6)
      .items_center()
      .bg(isSel ? t.selected : t.surface)
      .text_color(isSel ? t.foreground : t.muted)
      .border_1()
      .border_color(isSel ? t.accent : t.border)
      .child(
        svg("mods/skill-hub/skills.svg")
          .size(14)
          .text_color(installed ? t.done || "#2ea043" : isSel ? t.accent : t.muted)
      )
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(2)
          .child(
            h_flex()
              .items_center()
              .gap(6)
              .child(
                div()
                  .flex_1()
                  .min_w(0)
                  .text_size(12.5)
                  .font_semibold()
                  .truncate()
                  .text_color(t.foreground)
                  .child(item.name)
              )
              .when(installed, (sub) =>
                sub.child(
                  div()
                    .px(4)
                    .py(0.5)
                    .rounded(3)
                    .bg(t.done + "22")
                    .text_size(9)
                    .font_bold()
                    .text_color(t.done || "#2ea043")
                    .child("✓")
                )
              )
              .when(Boolean(primaryTag), (sub) =>
                sub.child(
                  div()
                    .px(4)
                    .py(0.5)
                    .rounded(3)
                    .bg(t.raised)
                    .text_size(9)
                    .text_color(t.dim)
                    .child(primaryTag)
                )
              )
              .when(Boolean(statsInfo?.stats && typeof statsInfo.stats.stars === "number"), (sub) =>
                sub.child(
                  div()
                    .px(4)
                    .py(0.5)
                    .rounded(3)
                    .bg(t.raised)
                    .border_1()
                    .border_color(t.border)
                    .text_size(9)
                    .font_bold()
                    .text_color(t.ansi3 || "#e3b341")
                    .child(`★ ${formatStars(statsInfo.stats.stars)}`)
                )
              )
          )
          .child(
            div()
              .text_size(10.5)
              .truncate()
              .text_color(t.dim)
              .child(item.description || item.source)
          )
      );
  }

  render(cx) {
    const t = theme();
    const isOverlay = Boolean(props()?.overlay);
    const filteredInstalled = this.filteredSkills();
    const filteredHub = this.filteredHubSkills();
    const hubShown = filteredHub.slice(0, this.hubVisibleCount);
    const skill = this.selected;
    const hubSkill = this.selectedHubSkill;
    const isHidden = skill && this.hiddenSkills.has(skill.id);
    const activeCount = this.skills.filter((s) => !this.hiddenSkills.has(s.id)).length;
    const hiddenCount = this.skills.filter((s) => this.hiddenSkills.has(s.id)).length;
    const hasDiff = Boolean(this.pendingDiff && skill && this.pendingDiff.skillId === skill.id);
    const skillUpdate = skill ? this.skillsUpdates.get(skill.id) : null;
    const skillStats = skill ? this.getSkillStats(skill.id) : null;

    return v_flex()
      .id("skills-mod-root")
      .track_focus(this.handle)
      .w(1020)
      .h(690)
      .max_w_full()
      .max_h_full()
      .bg(t.popover)
      .text_color(t.foreground)
      .child(
        // Top Toolbar
        h_flex()
          .h(50)
          .flex_none()
          .px(14)
          .gap(10)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .bg(t.chrome)
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .child(svg("mods/skill-hub/skills.svg").size(18).text_color(t.accent))
              .child(div().text_size(14).font_bold().text_color(t.foreground).child("Skills"))
          )
          // Main Section Mode Switcher (Zainstalowane vs Skillshare Hub)
          .child(
            h_flex()
              .h(30)
              .p(2)
              .rounded(6)
              .bg(t.surface)
              .border_1()
              .border_color(t.border)
              .items_center()
              .gap(2)
              .child(
                div()
                  .px(10)
                  .py(3)
                  .rounded(4)
                  .text_size(11.5)
                  .font_bold()
                  .cursor_pointer()
                  .bg(this.mainTab === "installed" ? t.selected : t.surface)
                  .text_color(this.mainTab === "installed" ? t.foreground : t.dim)
                  .hover((s) => s.text_color(t.foreground))
                  .on_click((_e, cx) => {
                    this.mainTab = "installed";
                    this.syncSelection();
                    cx.notify();
                  })
                  .child(`Zainstalowane (${this.skills.length})`)
              )
              .child(
                div()
                  .px(10)
                  .py(3)
                  .rounded(4)
                  .text_size(11.5)
                  .font_bold()
                  .cursor_pointer()
                  .bg(this.mainTab === "hub" ? t.selected : t.surface)
                  .text_color(this.mainTab === "hub" ? t.foreground : t.dim)
                  .hover((s) => s.text_color(t.foreground))
                  .on_click((_e, cx) => {
                    this.mainTab = "hub";
                    this.syncHubSelection();
                    cx.notify();
                  })
                  .child(`🌐 Skillshare Hub (${this.hubSkills.length})`)
              )
          )
          // Search Bar
          .child(
            h_flex()
              .flex_1()
              .h(32)
              .px(10)
              .gap(8)
              .items_center()
              .rounded(6)
              .border_1()
              .border_color(t.input)
              .bg(t.background)
              .child(svg("mods/workspace-chrome/search.svg").size(14).text_color(t.dim))
              .child(Input.new(this.searchInput).flex_1().h_full().text_size(12.5).text_color(t.foreground))
              .when(Boolean(this.filter), (el) =>
                el.child(
                  div()
                    .px(4)
                    .cursor_pointer()
                    .text_size(12)
                    .text_color(t.dim)
                    .hover((s) => s.text_color(t.foreground))
                    .on_click((_e, cx) => {
                      this.searchInput.set_value("");
                      this.filter = "";
                      if (this.mainTab === "installed") {
                        this.syncSelection();
                      } else {
                        this.syncHubSelection();
                      }
                      cx.notify();
                    })
                    .child("✕")
                )
              )
          )
          // Action Buttons: Check Updates (installed mode)
          .when(this.mainTab === "installed", (el) =>
            el.child(
              h_flex()
                .h(30)
                .px(10)
                .gap(5)
                .items_center()
                .rounded(6)
                .bg(t.surface)
                .border_1()
                .border_color(t.border)
                .text_size(12)
                .text_color(t.muted)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .on_click((_e, cx) => this.checkAllUpdates(cx))
                .child(this.checkingUpdates ? "⏳ Sprawdzanie…" : "🔍 Sprawdź aktualizacje")
            )
          )
          // Refresh Button
          .child(
            h_flex()
              .h(30)
              .px(10)
              .gap(5)
              .items_center()
              .rounded(6)
              .bg(t.surface)
              .border_1()
              .border_color(t.border)
              .text_size(12)
              .text_color(t.muted)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => this.load(cx))
              .child("↻ Odśwież")
          )
          // Close button if overlay
          .when(isOverlay, (el) =>
            el.child(
              div()
                .size(28)
                .rounded(6)
                .flex()
                .items_center()
                .justify_center()
                .cursor_pointer()
                .hover((s) => s.bg(t.hover))
                .on_click(() => closeOverlay(props().overlay))
                .child(svg("mods/pane/close.svg").size(14).text_color(t.muted))
            )
          )
      )
      // Sub-Tabs Bar: Installed Scope (Active / Hidden / All) OR Hub Categories
      .child(
        h_flex()
          .h(34)
          .flex_none()
          .px(14)
          .gap(6)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .bg(t.background)
          .when(this.mainTab === "installed", (el) =>
            el
              .child(
                div()
                  .px(8)
                  .py(2)
                  .rounded(4)
                  .text_size(11)
                  .font_semibold()
                  .cursor_pointer()
                  .bg(this.scopeFilter === "active" ? t.selected : t.surface)
                  .text_color(this.scopeFilter === "active" ? t.foreground : t.dim)
                  .hover((s) => s.text_color(t.foreground))
                  .on_click((_e, cx) => {
                    this.scopeFilter = "active";
                    this.syncSelection();
                    cx.notify();
                  })
                  .child(`Aktywne (${activeCount})`)
              )
              .child(
                div()
                  .px(8)
                  .py(2)
                  .rounded(4)
                  .text_size(11)
                  .font_semibold()
                  .cursor_pointer()
                  .bg(this.scopeFilter === "hidden" ? t.selected : t.surface)
                  .text_color(this.scopeFilter === "hidden" ? t.foreground : t.dim)
                  .hover((s) => s.text_color(t.foreground))
                  .on_click((_e, cx) => {
                    this.scopeFilter = "hidden";
                    this.syncSelection();
                    cx.notify();
                  })
                  .child(`Ukryte (${hiddenCount})`)
              )
              .child(
                div()
                  .px(8)
                  .py(2)
                  .rounded(4)
                  .text_size(11)
                  .font_semibold()
                  .cursor_pointer()
                  .bg(this.scopeFilter === "all" ? t.selected : t.surface)
                  .text_color(this.scopeFilter === "all" ? t.foreground : t.dim)
                  .hover((s) => s.text_color(t.foreground))
                  .on_click((_e, cx) => {
                    this.scopeFilter = "all";
                    this.syncSelection();
                    cx.notify();
                  })
                  .child(`Wszystkie (${this.skills.length})`)
              )
          )
          .when(this.mainTab === "hub", (el) =>
            el.children(
              HUB_CATEGORIES.map((cat) => {
                const isCatSel = this.hubCategory === cat.id;
                return div()
                  .px(8)
                  .py(2)
                  .rounded(4)
                  .text_size(11)
                  .font_semibold()
                  .cursor_pointer()
                  .bg(isCatSel ? t.selected : t.surface)
                  .text_color(isCatSel ? t.foreground : t.dim)
                  .hover((s) => s.text_color(t.foreground))
                  .on_click((_e, cx) => {
                    this.hubCategory = cat.id;
                    this.hubVisibleCount = this.hubPageSize;
                    this.syncHubSelection();
                    cx.notify();
                  })
                  .child(cat.label);
              })
            )
          )
      )
      // Main Body
      .child(
        h_flex()
          .flex_1()
          .min_h(0)
          .w_full()
          // Left Column (List)
          .child(
            v_flex()
              .w(330)
              .flex_none()
              .h_full()
              .min_h(0)
              .border_r(1)
              .border_color(t.border)
              .bg(t.chrome)
              .child(
                h_flex()
                  .h(32)
                  .flex_none()
                  .px(12)
                  .items_center()
                  .justify_between()
                  .border_b(1)
                  .border_color(t.border)
                  .child(
                    div()
                      .text_size(11)
                      .font_medium()
                      .text_color(t.dim)
                      .child(
                        this.loading
                          ? "Ładowanie…"
                          : this.mainTab === "installed"
                          ? `${filteredInstalled.length} ${filteredInstalled.length === 1 ? "skill" : "skilli"}`
                          : `${filteredHub.length} skilli w katalogu`
                      )
                  )
                  .when(this.mainTab === "installed" && this.skillsUpdates.size > 0, (el) =>
                    el.child(
                      div()
                        .px(6)
                        .py(1)
                        .rounded(4)
                        .bg(t.accent + "22")
                        .text_size(10.5)
                        .font_bold()
                        .text_color(t.accent)
                        .child(`Aktualizacje: ${this.skillsUpdates.size}`)
                    )
                  )
                  // Sort Switcher Button
                  .child(
                    h_flex()
                      .gap(3)
                      .items_center()
                      .cursor_pointer()
                      .px(6)
                      .py(2)
                      .rounded(4)
                      .bg(t.surface)
                      .border_1()
                      .border_color(t.border)
                      .hover((s) => s.bg(t.hover))
                      .on_click((_e, cx) => {
                        if (this.mainTab === "hub") {
                          this.hubSort = this.hubSort === "stars" ? "name" : "stars";
                          this.syncHubSelection();
                        } else {
                          this.installedSort = this.installedSort === "stars" ? "name" : "stars";
                          this.syncSelection();
                        }
                        cx.notify();
                      })
                      .child(
                        div()
                          .text_size(10)
                          .font_semibold()
                          .text_color(
                            (this.mainTab === "hub" ? this.hubSort === "stars" : this.installedSort === "stars")
                              ? (t.ansi3 || "#e3b341")
                              : t.dim
                          )
                          .child(
                            (this.mainTab === "hub" ? this.hubSort === "stars" : this.installedSort === "stars")
                              ? "⭐ Gwiazdki"
                              : "🔤 Nazwa"
                          )
                      )
                  )
              )
              // List items
              .child(
                v_flex()
                  .flex_1()
                  .min_h(0)
                  .overflow_y_scrollbar()
                  .p(6)
                  .gap(2)
                  // When Installed Tab is Active
                  .when(this.mainTab === "installed", (el) =>
                    el
                      .when(filteredInstalled.length === 0 && !this.loading, (sub) =>
                        sub.child(
                          div()
                            .p(16)
                            .text_size(12)
                            .text_color(t.dim)
                            .child(
                              Boolean(this.filter)
                                ? `Brak skilli pasujących do "${this.filter}"`
                                : this.scopeFilter === "hidden"
                                ? "Brak ukrytych skilli"
                                : "Nie znaleziono skilli"
                            )
                        )
                      )
                      .children(
                        filteredInstalled.map((item) => {
                          const isSel = skill && skill.id === item.id;
                          const itemHidden = this.hiddenSkills.has(item.id);
                          const hasItemUpdate = this.skillsUpdates.get(item.id);
                          const itemStats = this.getSkillStats(item.id);

                          return h_flex()
                            .id(`skill-item-${item.id}`)
                            .px(10)
                            .py(7)
                            .gap(8)
                            .rounded(6)
                            .items_center()
                            .cursor_pointer()
                            .bg(isSel ? t.selected : t.surface)
                            .text_color(isSel ? t.foreground : t.muted)
                            .border_1()
                            .border_color(isSel ? t.accent : t.border)
                            .hover((s) => s.bg(isSel ? t.selected : t.hover))
                            .on_click((_e, cx) => {
                              this.selectSkill(item);
                              cx.notify();
                            })
                            .child(
                              svg("mods/skill-hub/skills.svg")
                                .size(14)
                                .text_color(hasItemUpdate ? t.accent : itemHidden ? t.dim : isSel ? t.accent : t.muted)
                            )
                            .child(
                              v_flex()
                                .flex_1()
                                .min_w(0)
                                .gap(2)
                                .child(
                                  h_flex()
                                    .items_center()
                                    .gap(6)
                                    .child(
                                      div()
                                        .flex_1()
                                        .min_w(0)
                                        .text_size(12.5)
                                        .font_semibold()
                                        .truncate()
                                        .text_color(itemHidden ? t.dim : t.foreground)
                                        .child(item.name)
                                    )
                                    .when(Boolean(hasItemUpdate), (sub) =>
                                      sub.child(
                                        div()
                                          .px(4)
                                          .py(0.5)
                                          .rounded(3)
                                          .bg(t.accent)
                                          .text_size(9)
                                          .font_bold()
                                          .text_color("#ffffff")
                                          .child(`⚡ +${hasItemUpdate.stats.add}/-${hasItemUpdate.stats.del}`)
                                      )
                                    )
                                    .when(itemHidden, (sub) =>
                                      sub.child(
                                        div()
                                          .px(4)
                                          .py(0.5)
                                          .rounded(3)
                                          .bg(t.raised)
                                          .text_size(9)
                                          .text_color(t.dim)
                                          .child("Hidden")
                                      )
                                    )
                                    .when(item.hasGit, (sub) =>
                                      sub.child(
                                        div()
                                          .px(4)
                                          .py(0.5)
                                          .rounded(3)
                                          .bg(t.surface)
                                          .border_1()
                                          .border_color(t.border)
                                          .text_size(9)
                                          .text_color(t.dim)
                                          .child("Git")
                                      )
                                    )
                                    .when(Boolean(item.lockInfo), (sub) =>
                                      sub.child(
                                        div()
                                          .px(4)
                                          .py(0.5)
                                          .rounded(3)
                                          .bg(t.surface)
                                          .border_1()
                                          .border_color(t.border)
                                          .text_size(9)
                                          .text_color(t.dim)
                                          .child(item.lockInfo.source.split("/")[0])
                                      )
                                    )
                                    .when(Boolean(itemStats?.stats && typeof itemStats.stats.stars === "number"), (sub) =>
                                      sub.child(
                                        div()
                                          .px(4)
                                          .py(0.5)
                                          .rounded(3)
                                          .bg(t.raised)
                                          .border_1()
                                          .border_color(t.border)
                                          .text_size(9)
                                          .font_bold()
                                          .text_color(t.ansi3 || "#e3b341")
                                          .child(`★ ${formatStars(itemStats.stats.stars)}`)
                                      )
                                    )
                                )
                                .child(
                                  div()
                                    .text_size(10.5)
                                    .truncate()
                                    .text_color(t.dim)
                                    .child(item.shortDescription || "Instrukcja skilla")
                                )
                            );
                        })
                      )
                  )
                  // When Hub Tab is Active
                  .when(this.mainTab === "hub", (el) =>
                    el
                      .when(filteredHub.length === 0 && !this.loading, (sub) =>
                        sub.child(
                          div()
                            .p(16)
                            .text_size(12)
                            .text_color(t.dim)
                            .child(
                              Boolean(this.filter)
                                ? `Brak skilli w katalogu pasujących do "${this.filter}"`
                                : "Brak skilli w tej kategorii"
                            )
                        )
                      )
                      .children(
                        hubShown.map((item) => {
                          const isSel = hubSkill && hubSkill.name === item.name;
                          const installed = this.isSkillInstalled(item.name);
                          const primaryTag = Array.isArray(item.tags) && item.tags.length > 0 ? item.tags[0] : null;
                          const statsInfo = this.getSkillStats(item.source);

                          return h_flex()
                            .id(`hub-item-${item.name}`)
                            .px(10)
                            .py(7)
                            .gap(8)
                            .rounded(6)
                            .items_center()
                            .cursor_pointer()
                            .bg(isSel ? t.selected : t.surface)
                            .text_color(isSel ? t.foreground : t.muted)
                            .border_1()
                            .border_color(isSel ? t.accent : t.border)
                            .hover((s) => s.bg(isSel ? t.selected : t.hover))
                            .on_click((_e, cx) => {
                              this.selectedHubSkill = item;
                              cx.notify();
                            })
                            .child(
                              svg("mods/skill-hub/skills.svg")
                                .size(14)
                                .text_color(installed ? t.done || "#2ea043" : isSel ? t.accent : t.muted)
                            )
                            .child(
                              v_flex()
                                .flex_1()
                                .min_w(0)
                                .gap(2)
                                .child(
                                  h_flex()
                                    .items_center()
                                    .gap(6)
                                    .child(
                                      div()
                                        .flex_1()
                                        .min_w(0)
                                        .text_size(12.5)
                                        .font_semibold()
                                        .truncate()
                                        .text_color(t.foreground)
                                        .child(item.name)
                                    )
                                    .when(installed, (sub) =>
                                      sub.child(
                                        div()
                                          .px(4)
                                          .py(0.5)
                                          .rounded(3)
                                          .bg(t.done + "22")
                                          .text_size(9)
                                          .font_bold()
                                          .text_color(t.done || "#2ea043")
                                          .child("✓")
                                      )
                                    )
                                    .when(Boolean(primaryTag), (sub) =>
                                      sub.child(
                                        div()
                                          .px(4)
                                          .py(0.5)
                                          .rounded(3)
                                          .bg(t.raised)
                                          .text_size(9)
                                          .text_color(t.dim)
                                          .child(primaryTag)
                                      )
                                    )
                                    .when(Boolean(statsInfo?.stats && typeof statsInfo.stats.stars === "number"), (sub) =>
                                      sub.child(
                                        div()
                                          .px(4)
                                          .py(0.5)
                                          .rounded(3)
                                          .bg(t.raised)
                                          .border_1()
                                          .border_color(t.border)
                                          .text_size(9)
                                          .font_bold()
                                          .text_color(t.ansi3 || "#e3b341")
                                          .child(`★ ${formatStars(statsInfo.stats.stars)}`)
                                      )
                                    )
                                )
                                .child(
                                  div()
                                    .text_size(10.5)
                                    .truncate()
                                    .text_color(t.dim)
                                    .child(item.description || item.source)
                                )
                            );
                        })
                      )
                      .when(filteredHub.length > hubShown.length, (el) =>
                        el.child(
                          div()
                            .id("hub-show-more")
                            .mt(2)
                            .px(10)
                            .py(6)
                            .rounded(6)
                            .cursor_pointer()
                            .bg(t.raised)
                            .border_1()
                            .border_color(t.border)
                            .text_size(11)
                            .text_color(t.foreground)
                            .hover((s) => s.bg(t.hover))
                            .on_click((_e, cx) => {
                              this.hubVisibleCount = Math.min(
                                this.hubVisibleCount + this.hubPageSize,
                                filteredHub.length
                              );
                              cx.notify();
                            })
                            .child(`Pokaż więcej (${filteredHub.length - hubShown.length})`)
                        )
                      )
                  )
              )
          )
          // Right Column: Hub Detail OR Installed Skill Detail
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .h_full()
              .min_h(0)
              .bg(t.background)
              // HUB DETAIL
              .when(this.mainTab === "hub" && Boolean(hubSkill), (el) =>
                el.child(this.renderHubDetail(t, hubSkill))
              )
              .when(this.mainTab === "hub" && !hubSkill, (el) =>
                el
                  .items_center()
                  .justify_center()
                  .child(
                    div()
                      .p(24)
                      .text_size(13)
                      .text_color(t.dim)
                      .child(
                        Boolean(this.filter)
                          ? `Brak skilli w katalogu Hub dla "${this.filter}".`
                          : "Wybierz skill z katalogu Hub"
                      )
                  )
              )
              // INSTALLED DETAIL: Empty State
              .when(this.mainTab === "installed" && !skill, (el) =>
                el
                  .items_center()
                  .justify_center()
                  .child(
                    div()
                      .p(24)
                      .text_size(13)
                      .text_color(t.dim)
                      .child(
                        this.loading
                          ? "Ładowanie skilli…"
                          : Boolean(this.filter)
                          ? `Brak skilli pasujących do "${this.filter}". Wyczyść filtr, aby zobaczyć wszystkie.`
                          : "Wybierz skill z listy"
                      )
                  )
              )
              // INSTALLED DETAIL: Diff Preview Active
              .when(this.mainTab === "installed" && hasDiff, (el) =>
                el.child(this.renderDiffView(t, skill, this.pendingDiff))
              )
              // INSTALLED DETAIL: Normal View
              .when(this.mainTab === "installed" && Boolean(skill) && !hasDiff, (el) =>
                el
                  .child(
                    // Skill Header
                    h_flex()
                      .h(58)
                      .flex_none()
                      .px(16)
                      .gap(10)
                      .items_center()
                      .border_b(1)
                      .border_color(t.border)
                      .bg(t.surface)
                      .child(
                        v_flex()
                          .flex_1()
                          .min_w(0)
                          .gap(2)
                          .child(
                            h_flex()
                              .items_center()
                              .gap(8)
                              .child(
                                div()
                                  .text_size(16)
                                  .font_bold()
                                  .text_color(t.foreground)
                                  .truncate()
                                  .child(skill.name)
                              )
                              .when(isHidden, (sub) =>
                                sub.child(
                                  div()
                                    .px(6)
                                    .py(1)
                                    .rounded(4)
                                    .bg(t.raised)
                                    .text_size(10)
                                    .font_semibold()
                                    .text_color(t.dim)
                                    .child("Ukryty")
                                )
                              )
                              .when(skill.hasGit, (sub) =>
                                sub.child(
                                  div()
                                    .px(6)
                                    .py(1)
                                    .rounded(4)
                                    .bg(t.surface)
                                    .border_1()
                                    .border_color(t.border)
                                    .text_size(10)
                                    .text_color(t.muted)
                                    .child("Git Tracked")
                                )
                              )
                              .when(Boolean(skill.lockInfo), (sub) =>
                                sub.child(
                                  div()
                                    .px(6)
                                    .py(1)
                                    .rounded(4)
                                    .bg(t.surface)
                                    .border_1()
                                    .border_color(t.border)
                                    .text_size(10)
                                    .text_color(t.muted)
                                    .child(`Source: ${skill.lockInfo.source}`)
                                )
                              )
                              .when(Boolean(skillStats?.stats && typeof skillStats.stats.stars === "number"), (sub) =>
                                sub.child(
                                  div()
                                    .px(6)
                                    .py(1)
                                    .rounded(4)
                                    .bg(t.raised)
                                    .border_1()
                                    .border_color(t.border)
                                    .text_size(10.5)
                                    .font_bold()
                                    .text_color(t.ansi3 || "#e3b341")
                                    .child(`⭐ ${skillStats.stats.stars.toLocaleString()} gwiazdek`)
                                )
                              )
                          )
                          .child(
                            div()
                              .text_size(11)
                              .text_color(t.dim)
                              .truncate()
                              .child(`~/.agents/skills/${skill.id}/SKILL.md`)
                          )
                      )
                      // Primary Actions
                      .child(
                        h_flex()
                          .h(30)
                          .px(10)
                          .gap(5)
                          .items_center()
                          .rounded(6)
                          .bg(t.solid)
                          .text_color(t.solid_foreground)
                          .text_size(12)
                          .font_semibold()
                          .cursor_pointer()
                          .hover((s) => s.opacity(0.88))
                          .on_click((_e, cx) => this.copyPrompt(skill, cx))
                          .child("📋 Kopiuj Prompt")
                      )
                      .child(
                        h_flex()
                          .h(30)
                          .px(9)
                          .items_center()
                          .rounded(6)
                          .bg(t.raised)
                          .border_1()
                          .border_color(t.border)
                          .text_color(t.foreground)
                          .text_size(11.5)
                          .cursor_pointer()
                          .hover((s) => s.bg(t.hover))
                          .on_click((_e, cx) => this.copyName(skill, cx))
                          .child("Kopiuj Nazwę")
                      )
                      .child(
                        h_flex()
                          .h(30)
                          .px(9)
                          .items_center()
                          .rounded(6)
                          .bg(t.raised)
                          .border_1()
                          .border_color(t.border)
                          .text_color(t.foreground)
                          .text_size(11.5)
                          .cursor_pointer()
                          .hover((s) => s.bg(t.hover))
                          .on_click((_e, cx) => this.sendToTerminal(skill, cx))
                          .child("Do Terminala")
                      )
                      .child(
                        h_flex()
                          .h(30)
                          .px(9)
                          .items_center()
                          .rounded(6)
                          .bg(t.raised)
                          .border_1()
                          .border_color(t.border)
                          .text_color(t.foreground)
                          .text_size(11.5)
                          .cursor_pointer()
                          .hover((s) => s.bg(t.hover))
                          .on_click(() => this.openFolder(skill))
                          .child("Folder ↗")
                      )
                  )
                  // Management Toolbar
                  .child(
                    h_flex()
                      .h(36)
                      .flex_none()
                      .px(16)
                      .gap(8)
                      .items_center()
                      .bg(t.chrome)
                      .border_b(1)
                      .border_color(t.border)
                      // Hide / Unhide Button
                      .child(
                        h_flex()
                          .h(26)
                          .px(8)
                          .gap(4)
                          .items_center()
                          .rounded(4)
                          .bg(isHidden ? t.selected : t.surface)
                          .border_1()
                          .border_color(t.border)
                          .text_size(11.5)
                          .text_color(t.foreground)
                          .cursor_pointer()
                          .hover((s) => s.bg(t.hover))
                          .on_click((_e, cx) => this.toggleHidden(skill, cx))
                          .child(isHidden ? "👁 Odkryj skill" : "👁 Ukryj skill")
                      )
                      // Diff / Update Preview Action (if update already detected)
                      .when(Boolean(skillUpdate), (sub) =>
                        sub.child(
                          h_flex()
                            .h(26)
                            .px(9)
                            .gap(4)
                            .items_center()
                            .rounded(4)
                            .bg(t.accent)
                            .text_color("#ffffff")
                            .text_size(11.5)
                            .font_semibold()
                            .cursor_pointer()
                            .hover((s) => s.opacity(0.9))
                            .on_click((_e, cx) => {
                              this.pendingDiff = skillUpdate;
                              cx.notify();
                            })
                            .child(`⚡ Zobacz zmiany (+${skillUpdate.stats.add}/-${skillUpdate.stats.del})`)
                        )
                      )
                      // Check Update Button (for git or lockfile)
                      .when((skill.hasGit || Boolean(skill.lockInfo)) && !skillUpdate, (sub) =>
                        sub.child(
                          h_flex()
                            .h(26)
                            .px(8)
                            .gap(4)
                            .items_center()
                            .rounded(4)
                            .bg(t.surface)
                            .border_1()
                            .border_color(t.border)
                            .text_size(11.5)
                            .text_color(t.foreground)
                            .cursor_pointer()
                            .hover((s) => s.bg(t.hover))
                            .on_click((_e, cx) => this.checkSkillUpdate(skill, cx))
                            .child(this.checkingUpdates ? "⏳ Sprawdzam…" : "🔍 Sprawdź zmiany")
                        )
                      )
                      // Edit Mode Toggle
                      .when(!this.isEditing, (sub) =>
                        sub.child(
                          h_flex()
                            .h(26)
                            .px(8)
                            .gap(4)
                            .items_center()
                            .rounded(4)
                            .bg(t.surface)
                            .border_1()
                            .border_color(t.border)
                            .text_size(11.5)
                            .text_color(t.foreground)
                            .cursor_pointer()
                            .hover((s) => s.bg(t.hover))
                            .on_click((_e, cx) => {
                              this.isEditing = true;
                              this.recreateEditor(skill, false);
                              cx.notify();
                            })
                            .child("✏️ Edytuj treść")
                        )
                      )
                      // Save button when editing
                      .when(this.isEditing, (sub) =>
                        sub
                          .child(
                            h_flex()
                              .h(26)
                              .px(10)
                              .gap(4)
                              .items_center()
                              .rounded(4)
                              .bg(t.done || "#2ea043")
                              .text_color("#ffffff")
                              .text_size(11.5)
                              .font_semibold()
                              .cursor_pointer()
                              .hover((s) => s.opacity(0.9))
                              .on_click((_e, cx) => this.saveSkillContent(skill, cx))
                              .child("💾 Zapisz zmiany")
                          )
                          .child(
                            h_flex()
                              .h(26)
                              .px(8)
                              .items_center()
                              .rounded(4)
                              .bg(t.surface)
                              .border_1()
                              .border_color(t.border)
                              .text_size(11.5)
                              .text_color(t.muted)
                              .cursor_pointer()
                              .hover((s) => s.bg(t.hover))
                              .on_click((_e, cx) => {
                                this.isEditing = false;
                                this.recreateEditor(skill, true);
                                cx.notify();
                              })
                              .child("Anuluj")
                          )
                      )
                      .child(div().flex_1())
                      // Delete Skill Button
                      .child(
                        h_flex()
                          .h(26)
                          .px(8)
                          .gap(4)
                          .items_center()
                          .rounded(4)
                          .bg(this.deletingId === skill.id ? (t.blocked || "#da3633") : t.surface)
                          .border_1()
                          .border_color(this.deletingId === skill.id ? (t.blocked || "#da3633") : t.border)
                          .text_size(11.5)
                          .text_color(this.deletingId === skill.id ? "#ffffff" : (t.blocked || "#e06c75"))
                          .cursor_pointer()
                          .hover((s) => s.opacity(0.88))
                          .on_click((_e, cx) => {
                            if (this.deletingId === skill.id) {
                              this.deleteSkill(skill, cx);
                            } else {
                              this.deletingId = skill.id;
                              cx.notify();
                            }
                          })
                          .child(this.deletingId === skill.id ? "⚠️ Kliknij by potwierdzić" : "🗑 Usuń")
                      )
                      .when(this.deletingId === skill.id, (sub) =>
                        sub.child(
                          div()
                            .px(4)
                            .cursor_pointer()
                            .text_size(11)
                            .text_color(t.dim)
                            .hover((s) => s.text_color(t.foreground))
                            .on_click((_e, cx) => {
                              this.deletingId = null;
                              cx.notify();
                            })
                            .child("Anuluj")
                        )
                      )
                  )
                  // Skrócony opis & Full Description Box
                  .child(
                    v_flex()
                      .flex_none()
                      .m(12)
                      .p(10)
                      .rounded(6)
                      .bg(t.surface)
                      .border_1()
                      .border_color(t.border)
                      .gap(4)
                      .child(
                        h_flex()
                          .items_center()
                          .justify_between()
                          .child(
                            div()
                              .text_size(10.5)
                              .font_semibold()
                              .text_color(t.dim)
                              .child("SKRÓCONY OPIS")
                          )
                          .when(
                            Boolean(skill.description) &&
                              skill.description.trim() !== skill.shortDescription.trim(),
                            (sub) =>
                              sub.child(
                                div()
                                  .cursor_pointer()
                                  .text_size(10.5)
                                  .text_color(t.accent)
                                  .hover((s) => s.underline())
                                  .on_click((_e, cx) => {
                                    this.showFullDesc = !this.showFullDesc;
                                    cx.notify();
                                  })
                                  .child(this.showFullDesc ? "▲ Mniej" : "▼ Pełny opis")
                              )
                          )
                      )
                      .child(
                        div()
                          .text_size(12)
                          .line_height("18px")
                          .text_color(t.foreground)
                          .child(
                            this.showFullDesc
                              ? skill.description || "Brak opisu."
                              : skill.shortDescription || "Brak opisu."
                          )
                      )
                  )
                  // GitHub Repository Statistics Box
                  .when(Boolean(skillStats?.stats), (sub) =>
                    sub.child(this.renderGitHubStatsBox(t, skillStats))
                  )
                  // Markdown Content Area
                  .child(
                    v_flex()
                      .flex_1()
                      .min_h(0)
                      .px(12)
                      .pb(12)
                      .child(Editor.new(this.code).size_full())
                  )
              )
          )
      );
  }
}
