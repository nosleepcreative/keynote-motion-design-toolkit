/*
Script Name: Render Array
Description: Queue the active comp as multiple render items — split by markers,
             head / tail, or one PNG snapshot per marker — from a dockable panel.
Author: Desmond Du | nosleepcreative
Website: duitbetter.com | github.com/nosleepcreative | youtube.com/@NoSleepCreative
Version: 1.0.0
Date: 2026-10-20

Install: copy into After Effects' Scripts/ScriptUI Panels/ folder, restart AE,
         and open it from the Window menu to dock it. Or run it from
         File > Scripts > Run Script File… as a floating panel.

Usage:   Pick a mode, check the Segments preview, press Queue. Items are only
         queued — nothing renders until you start the Render Queue.
         Markers whose comment starts with "!" are listed as alerts and
         skipped. The gear opens Settings (output folder, subfolder pattern,
         templates, marker filter); they're saved in AE's preferences.
*/

(function (thisObj) {
    "use strict";

    var VERSION = "1.0.0";

    // ── constants (not user-facing) ───────────────────────────────────────────

    var CONFIG = {
        settingsSection   : "RenderArray",       // app.settings section name — keep as is,
                                                 // renaming it would orphan saved settings
        legacySection     : "RQ_QueueSegments",  // read-only fallback, pre-rename prefs
        snapshotAutoRx    : /png/i,              // auto-pick a snapshot template
        // Layout is built to a ~555 px panel: 18 margin + left column + 8 gap +
        // Segments panel (table + 2×10 margin) + 18 margin. Every fixed width
        // below is derived from that, so the panel never asks to be wider.
        panelWidth        : 555,                 // px; widest the panel will lay out
        leftColWidth      : 200,                 // px; Mode / Options column
        segListWidth      : 290,                 // px; table width before first layout
        segColWidths      : [62, 68, 68, 76],    // Segment, Start, End, Duration — minimums;
                                                 // spare width is shared out evenly
        segListHeight     : 160,                 // px; the segment table scrolls past this
        segListRows       : 6,                   // rows that fit before the table scrolls
        segListChrome     : 12,                  // px; listbox border + inner padding
        segScrollbar      : 17,                  // px; reserved only when the table scrolls
        alertMaxRows      : 3,                   // alert-footer lines before "…and N more"
        alertPrefix       : "!"                  // comment starting with this = alert marker
    };

    // ── persistent settings ───────────────────────────────────────────────────

    var DEFAULTS = {
        outputMode        : "project",   // "project" | "custom"
        customFolder      : "",          // absolute path, used when mode = custom
        rendersFolderPref : "RENDERS",   // preferred subfolder beside the project
        rendersFolderFall : "RENDER",    // accepted if it already exists
        subfolderPattern  : "{base}_{version}",  // token pattern, "" = none
        outputExtension   : ".mov",      // video modes
        snapshotExtension : ".png",      // Marker Snapshot
        renderSettings    : "",          // render-settings template, "" = AE default
        outputTemplate    : "",          // output-module template,   "" = AE default
        snapshotTemplate  : "",          // "" = first template matching snapshotAutoRx
        ignoreMarkers     : true,        // skip markers whose comment matches below
        ignoreMarkerMode  : "contains",  // "contains" | "startswith"
        ignoreMarkerText  : "-",         // the needle; blank disables the filter
        defaultDuration   : "2s",
        rememberLastUsed  : true,        // persist duration + In / Out after queueing
        useWorkArea       : false,       // "Limit to In / Out points", remembered with the duration
        previewUnits      : "frames"     // "frames" | "seconds", the Segments table's units button
    };

    var S = {};   // live settings

    var IS_WIN       = $.os.indexOf("Windows") !== -1;
    var UNDO_KEY     = IS_WIN ? "Ctrl+Z" : "Cmd+Z";
    var FILE_BROWSER = IS_WIN ? "Explorer" : "Finder";

    // Prefs saved before the rename sit under the old section. Read from there
    // until the first save writes the new one — whole section either way, so a
    // half-saved new section never mixes with old values.
    function readSection() {
        for (var k in DEFAULTS) {
            if (!DEFAULTS.hasOwnProperty(k)) continue;
            try { if (app.settings.haveSetting(CONFIG.settingsSection, k)) return CONFIG.settingsSection; }
            catch (e) { /* unreadable — keep looking */ }
        }
        return CONFIG.legacySection;
    }

    function loadSettings() {
        var out = {}, k, raw, sec = readSection();
        for (k in DEFAULTS) {
            if (!DEFAULTS.hasOwnProperty(k)) continue;
            out[k] = DEFAULTS[k];
            try {
                if (app.settings.haveSetting(sec, k)) {
                    raw = app.settings.getSetting(sec, k);
                    out[k] = (typeof DEFAULTS[k] === "boolean") ? (raw === "true") : raw;
                }
            } catch (e) { /* unreadable pref — keep the default */ }
        }

        // v2.5 stored a yes/no "useIdSubfolder". Anyone upgrading has that
        // saved and no subfolderPattern, so carry their choice across rather
        // than silently re-enabling a subfolder they had turned off.
        try {
            if (!app.settings.haveSetting(sec, "subfolderPattern") &&
                 app.settings.haveSetting(sec, "useIdSubfolder")) {
                out.subfolderPattern =
                    (app.settings.getSetting(sec, "useIdSubfolder") === "true")
                        ? DEFAULTS.subfolderPattern : "";
            }
        } catch (e2) { /* keep the default */ }

        return out;
    }

    function saveSettings(s) {
        for (var k in DEFAULTS) {
            if (!DEFAULTS.hasOwnProperty(k)) continue;
            try { app.settings.saveSetting(CONFIG.settingsSection, k, String(s[k])); }
            catch (e) { /* non-fatal: setting just won't persist */ }
        }
        // AE otherwise only flushes prefs on quit, which loses settings on a crash
        try { app.preferences.saveToDisk(); } catch (e2) { /* older AE */ }
    }

    // ── helpers ───────────────────────────────────────────────────────────────

    function trim(s) { return String(s).replace(/^\s+|\s+$/g, ""); }

    function plural(n, word) { return n + " " + word + (n !== 1 ? "s" : ""); }

    function parseSegDuration(raw, fps) {
        var s = trim(raw);
        if (/^\d+(\.\d+)?f$/i.test(s))  return parseFloat(s) / fps;
        if (/^\d+(\.\d+)?s?$/i.test(s)) return parseFloat(s);
        return NaN;
    }

    function indexToLetter(i) {
        return i < 26 ? String.fromCharCode(65 + i) : String(i + 1);
    }

    function sanitizeSuffix(s) {
        var r = trim(s).replace(/[^A-Za-z0-9\-]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
        return r || null;
    }

    // The comp name becomes the filename stem, so it has to survive being put in
    // a path. A comp called "Mode_02 (In / Out)" would otherwise try to write
    // across a directory boundary. Only illegal characters are touched — spaces
    // and case are left alone so filenames still read like the comp.
    function safeFileStem(name) {
        return trim(name).replace(/[\/\\:*?"<>|]/g, "_") || "Untitled";
    }

    // ".MOV" / "mov" / "  .mov " all normalise to ".mov"
    function normExt(e, fallback) {
        var x = trim(e).replace(/^\.+/, "").replace(/[^A-Za-z0-9]/g, "");
        return x ? "." + x.toLowerCase() : fallback;
    }

    function fmtTime(s) { return s.toFixed(2) + " s"; }

    // AE reports 29.97 as 29.9700012207031
    function fmtFps(r) { return String(Math.round(r * 100) / 100); }

    // Second segment of the comp name is NOT trusted as an ID on its own —
    // it has to look like an ID token, or we use the whole comp name.
    function parseIdFromName(name) {
        var m = String(name).match(/(^|_)(D?ID[0-9]+)(_|$)/i);
        return m ? m[2] : null;
    }

    function resolveId(name) {
        return parseIdFromName(name) || sanitizeSuffix(name) || "Untitled";
    }

    // ── subfolder pattern ─────────────────────────────────────────────────────

    function parseVersionFromName(name) {
        var m = String(name).match(/(^|_)(v[0-9]+)(_|$)/i);
        return m ? m[2] : "";
    }

    function parsePrefixFromName(name) {
        var m = String(name).match(/^([0-9]+)(_|$)/);
        return m ? m[1] : "";
    }

    // Comp name with the prefix, ID and version tokens taken out — what's left
    // is the part a human actually named. 010_ID1000_A1_Element_v001 → A1_Element
    function parseBaseFromName(name) {
        var s = String(name);
        s = s.replace(/^[0-9]+_/, "");
        s = s.replace(/(^|_)D?ID[0-9]+(_|$)/i, "$1");
        s = s.replace(/(^|_)v[0-9]+(_|$)/i, "$1");
        return trim(s).replace(/^_+|_+$/g, "");
    }

    function todayStamp() {
        var d = new Date(), p = function (n) { return (n < 10 ? "0" : "") + n; };
        return "" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
    }

    function subfolderTokens(name) {
        return {
            id     : resolveId(name),   // never empty — keeps the old fallback
            version: parseVersionFromName(name),
            prefix : parsePrefixFromName(name),
            base   : parseBaseFromName(name),
            comp   : safeFileStem(name),
            date   : todayStamp()
        };
    }

    function isGlueLiteral(s) { return /^[_\-.\s]+$/.test(s); }

    // Break one path segment into literal and token pieces. An unknown token is
    // kept as literal text rather than vanishing, so a typo is visible in the
    // path preview instead of quietly changing where renders land.
    function splitPattern(seg, tok) {
        var rx = /\{([A-Za-z]+)\}/g, pieces = [], last = 0, m, key;
        while ((m = rx.exec(seg)) !== null) {
            if (m.index > last) pieces.push({ text: seg.substring(last, m.index), glue: true });
            key = String(m[1]).toLowerCase();
            if (tok.hasOwnProperty(key)) pieces.push({ text: tok[key], glue: false });
            else pieces.push({ text: m[0], glue: true });
            last = m.index + m[0].length;
        }
        if (last < seg.length) pieces.push({ text: seg.substring(last), glue: true });
        return pieces;
    }

    // Join the pieces, dropping any separator that would be left dangling by an
    // empty token. Separators only survive between two pieces that both produced
    // something, so "{id}_{version}" on an unversioned comp is "ID1000".
    // Literal text that is not purely separators is always kept.
    function resolveSegment(seg, tok) {
        var pieces = splitPattern(seg, tok), out = "", i, j, p, hasNext;
        for (i = 0; i < pieces.length; i++) {
            p = pieces[i];
            if (!p.text) continue;
            if (p.glue && isGlueLiteral(p.text)) {
                if (!out) continue;                       // nothing to separate from
                if (/[_\-.\s]$/.test(out)) continue;      // already separated
                hasNext = false;
                for (j = i + 1; j < pieces.length; j++) {
                    if (pieces[j].text && !(pieces[j].glue && isGlueLiteral(pieces[j].text))) {
                        hasNext = true;
                        break;
                    }
                }
                if (!hasNext) continue;                   // nothing follows to separate
            }
            out += p.text;
        }
        return out.replace(/[\/\\:*?"<>|]/g, "_");
    }

    // "" when the pattern is blank or everything in it resolved to nothing —
    // callers treat that as "write straight into the output root".
    function resolveSubfolder(name) {
        var tok   = subfolderTokens(name),
            parts = String(S.subfolderPattern || "").split("/"),
            out   = [], i, seg;
        for (i = 0; i < parts.length; i++) {
            seg = resolveSegment(parts[i], tok);
            if (seg) out.push(seg);
        }
        return out.join("/");
    }

    // ── output location ───────────────────────────────────────────────────────

    // Reuse a renders folder that already exists whatever its case, so a project
    // carrying a legacy "renders/" doesn't sprout a second "RENDERS/" beside it
    // on a case-sensitive volume. Returns the real on-disk path, or null.
    function findFolderAnyCase(parentFolder, names) {
        var kids, i, j, nm;
        try { kids = parentFolder.getFiles(); } catch (e) { return null; }
        if (!kids) return null;
        for (j = 0; j < names.length; j++) {
            nm = trim(names[j]).toLowerCase();
            if (!nm) continue;
            for (i = 0; i < kids.length; i++) {
                if (kids[i] instanceof Folder && decodeURI(kids[i].name).toLowerCase() === nm) {
                    return kids[i].fsName;
                }
            }
        }
        return null;
    }

    // Where would this comp render to? Resolves only — creates nothing, so the
    // panel can show it live without touching the disk.
    function outputFolderPath(name) {
        var base, projFile, dir, found, sub;

        if (S.outputMode === "custom") {
            base = trim(S.customFolder).replace(/[\/\\]+$/, "");
            if (!base) return { error: "No custom output folder set — open Settings…" };
        } else {
            projFile = app.project.file;
            if (!projFile) {
                return { error: "Project not saved. Save it, or pick a custom output folder in Settings…" };
            }
            dir   = projFile.parent;
            found = findFolderAnyCase(dir, [S.rendersFolderPref, S.rendersFolderFall]);
            base  = found ? found : (dir.fsName + "/" + S.rendersFolderPref);
        }
        sub = resolveSubfolder(name);
        return { path: sub ? base + "/" + sub : base };
    }

    // Folder.create() does not reliably build intermediate folders — do it here.
    function ensureFolder(path) {
        var f = new Folder(path), parent;
        if (f.exists) return f;
        parent = f.parent;
        if (parent && parent.fsName !== f.fsName && !parent.exists) {
            if (!ensureFolder(parent.fsName)) return null;
        }
        return f.create() ? f : null;
    }

    // ── comp state (refreshed by loadComp) ───────────────────────────────────

    var comp      = null;
    var compName  = "";
    var duration  = 0;
    var frameRate = 1;
    var markers   = [];

    function compIsValid() {
        if (!(comp instanceof CompItem)) return false;
        try { return comp.name !== null; }   // throws if the comp was deleted
        catch (e) { return false; }
    }

    // Everything buildSegments() needs, read live off the comp. The ignore and
    // alert filters are applied here so every marker mode gets them from one
    // place — a filtered marker is invisible downstream, so Marker-to-Marker
    // spans over it.
    //
    // lo / hi is the span every mode works inside: the whole comp, or the work
    // area when "Limit to In / Out points" is ticked. Markers outside it are
    // dropped here and counted, so each mode treats the work area exactly as
    // if it were the comp — the last segment runs to the Out point.
    function compContext(c, mkrs, useWA) {
        var f  = filterMarkers(mkrs),
            lo = useWA ? c.workAreaStart : 0,
            hi = useWA ? c.workAreaStart + c.workAreaDuration : c.duration,
            kept = [], outside = 0, i;
        for (i = 0; i < f.markers.length; i++) {
            if (f.markers[i].time >= lo && f.markers[i].time < hi) kept.push(f.markers[i]);
            else outside++;
        }
        return {
            duration : c.duration,
            frameRate: c.frameRate,
            frameDur : c.frameDuration,
            useWA    : !!useWA,
            lo       : lo,
            hi       : hi,
            markers  : kept,
            outside  : outside,
            ignored  : f.ignored,
            alerts   : f.alerts
        };
    }

    // ── markers ───────────────────────────────────────────────────────────────

    function markerEntry(time, val) {
        var raw = (val.comment !== "") ? val.comment
                : (val.chapter !== "") ? val.chapter
                : "";
        return {
            time     : time,
            markerDur: val.duration,
            label    : raw           // untouched, for the ignore / alert filters
        };
    }

    // Sorted by time, then lettered by position — letter tracks marker number.
    function finishMarkers(list) {
        var i;
        list.sort(function (a, b) { return a.time - b.time; });
        for (i = 0; i < list.length; i++) {
            list[i].suffix = sanitizeSuffix(list[i].label) || indexToLetter(i);
        }
        return list;
    }

    function readCompMarkerEntries(c) {
        var prop = c.markerProperty, out = [], i;
        for (i = 1; i <= prop.numKeys; i++) out.push(markerEntry(prop.keyTime(i), prop.keyValue(i)));
        return out;
    }

    function readMarkers(c) { return finishMarkers(readCompMarkerEntries(c)); }

    // Unlabelled markers never match, otherwise a filter would silently swallow
    // every plain A/B/C marker.
    function labelMatches(m, on, mode, needle) {
        if (!on || !needle) return false;
        var hay = trim(m.label);
        if (!hay) return false;
        return (mode === "startswith")
            ? hay.substring(0, needle.length) === needle
            : hay.indexOf(needle) !== -1;
    }

    // Markers used as annotations rather than segment boundaries — by default any
    // comment containing "-".
    function markerIsIgnored(m) {
        return labelMatches(m, S.ignoreMarkers, S.ignoreMarkerMode, S.ignoreMarkerText);
    }

    // Markers that flag something to check — by default a comment starting "!".
    function markerIsAlert(m) {
        return labelMatches(m, true, "startswith", CONFIG.alertPrefix);
    }

    // Alert is tested first: a marker that matches both is something the user
    // asked to be told about, so it must never vanish into the ignored count.
    function filterMarkers(all) {
        var kept = [], ignored = 0, alerts = [], i;
        for (i = 0; i < all.length; i++) {
            if (markerIsAlert(all[i]))   { alerts.push(all[i]); continue; }
            if (markerIsIgnored(all[i])) { ignored++; continue; }
            kept.push(all[i]);
        }
        return { markers: kept, ignored: ignored, alerts: alerts };
    }

    // ── segment post-processing ───────────────────────────────────────────────

    // Snap every span to whole frames, keep it inside lo..hi, and drop anything
    // that rounds to nothing.
    function quantize(raw, ctx) {
        var out = [], dropped = 0, i, sf, df,
            minF = Math.round(ctx.lo / ctx.frameDur),
            maxF = Math.round(ctx.hi / ctx.frameDur);
        for (i = 0; i < raw.length; i++) {
            sf = Math.round(raw[i].start / ctx.frameDur);
            df = Math.round(raw[i].dur   / ctx.frameDur);
            if (sf < minF) { df -= (minF - sf); sf = minF; }
            if (sf + df > maxF) df = maxF - sf;
            if (df < 1) { dropped++; continue; }
            raw[i].start  = sf * ctx.frameDur;
            // land exactly on the end (comp end or Out point) rather than
            // frames*frameDur, which can float a hair past it and make AE clamp
            // the span behind our back
            raw[i].dur    = (sf + df >= maxF) ? (ctx.hi - raw[i].start) : (df * ctx.frameDur);
            raw[i].frames = df;
            out.push(raw[i]);
        }
        return { segs: out, dropped: dropped };
    }

    // Two markers commented the same would write to the same file — number them.
    function uniquify(segs) {
        var taken = {}, i, base, name, n;
        for (i = 0; i < segs.length; i++) {
            base = segs[i].suffix;
            name = base;
            n    = 1;
            while (taken["k_" + name.toLowerCase()]) { n++; name = base + "_" + n; }
            taken["k_" + name.toLowerCase()] = true;
            segs[i].suffix = name;
        }
        return segs;
    }

    // ── modes ─────────────────────────────────────────────────────────────────

    var MODES = [
        { key: "headtail",   needsDur: true,
          label: "Head / Tail",
          desc : "First N seconds (Part A) + last N seconds (Part B)." },
        { key: "m2m",        needsDur: false,
          label: "Marker to Marker",
          desc : "Each marker to the next; last segment runs to the end." },
        { key: "mdur",       needsDur: true,
          label: "Marker + Duration",
          desc : "Each marker start + fixed duration; last marker runs to the end." },
        { key: "mkrdur",     needsDur: false,
          label: "Marker Duration",
          desc : "Each marker's own range (none = skipped); last marker runs to the end." },
        { key: "mkrsnap",    needsDur: false,
          label: "Marker Snapshot",
          desc : "One PNG per marker; each render item is exactly one frame long." }
    ];

    function modeUsesMarkers(key) {
        return key === "m2m" || key === "mdur" || key === "mkrdur" || key === "mkrsnap";
    }

    // "No markers" reads as a mistake when a filter is what emptied the list.
    function noMarkerError(ctx, plain) {
        var why = [];
        if (ctx.ignored > 0)       why.push(plural(ctx.ignored, "marker") + " ignored");
        if (ctx.alerts.length > 0) why.push(plural(ctx.alerts.length, "alert marker"));
        if (ctx.outside > 0)       why.push(plural(ctx.outside, "marker") + " outside the In / Out points");
        if (why.length) return "No usable markers — " + why.join(", ") + ", none left to segment.";
        return plain;
    }

    // The one place segment ranges are decided. Both the live preview and the
    // queue button call this, so the preview cannot drift from what is queued.
    // Returns { segs, error, dropped, ignored, outside }.
    function buildSegments(mode, ctx, durText) {
        var res = { segs: [], error: null, dropped: 0, ignored: 0, outside: 0 };
        var segDur = NaN, raw = [], i, mk, start, end, next;

        if (modeUsesMarkers(mode)) { res.ignored = ctx.ignored; res.outside = ctx.outside; }

        if (mode === "headtail") {

            segDur = parseSegDuration(durText, ctx.frameRate);
            if (isNaN(segDur) || segDur <= 0) {
                res.error = "\"" + trim(durText) + "\" is not a valid duration.";
                return res;
            }
            start = ctx.lo;
            end   = ctx.hi;
            if (end - start < segDur * 2) {
                res.error = (ctx.useWA ? "Work area" : "Comp") + " is only " +
                            fmtTime(end - start) + " long — needs at least " +
                            fmtTime(segDur * 2) + " so Part A and Part B don't overlap.";
                return res;
            }
            raw.push({ start: start,          dur: segDur, suffix: "A" });
            raw.push({ start: end - segDur,   dur: segDur, suffix: "B" });

        } else if (mode === "m2m") {

            if (ctx.markers.length === 0) { res.error = noMarkerError(ctx, "No markers found."); return res; }
            for (i = 0; i < ctx.markers.length; i++) {
                next = (i < ctx.markers.length - 1) ? ctx.markers[i + 1].time : ctx.hi;
                raw.push({ start : ctx.markers[i].time,
                           dur   : next - ctx.markers[i].time,
                           suffix: ctx.markers[i].suffix });
            }

        } else if (mode === "mdur") {

            if (ctx.markers.length === 0) { res.error = noMarkerError(ctx, "No markers found."); return res; }
            segDur = parseSegDuration(durText, ctx.frameRate);
            if (isNaN(segDur) || segDur <= 0) {
                res.error = "\"" + trim(durText) + "\" is not a valid duration.";
                return res;
            }
            // the last marker has nothing after it to stop at — run it to the end
            for (i = 0; i < ctx.markers.length; i++) {
                raw.push({ start : ctx.markers[i].time,
                           dur   : (i === ctx.markers.length - 1)
                                       ? ctx.hi - ctx.markers[i].time
                                       : Math.min(segDur, ctx.hi - ctx.markers[i].time),
                           suffix: ctx.markers[i].suffix });
            }

        } else if (mode === "mkrdur") {

            // the last marker runs to the end whether or not it has a duration
            for (i = 0; i < ctx.markers.length; i++) {
                mk = ctx.markers[i];
                if (i === ctx.markers.length - 1) {
                    raw.push({ start: mk.time, dur: ctx.hi - mk.time, suffix: mk.suffix });
                } else if (mk.markerDur > 0) {
                    raw.push({ start: mk.time, dur: mk.markerDur, suffix: mk.suffix });
                }
            }
            if (raw.length === 0) { res.error = noMarkerError(ctx, "No markers with a duration found."); return res; }

        } else if (mode === "mkrsnap") {

            if (ctx.markers.length === 0) { res.error = noMarkerError(ctx, "No markers found."); return res; }
            for (i = 0; i < ctx.markers.length; i++) {
                raw.push({ start   : ctx.markers[i].time,
                           dur     : ctx.frameDur,
                           suffix  : ctx.markers[i].suffix,
                           snapshot: true });
            }

        } else {
            res.error = "Unknown mode \"" + mode + "\".";
            return res;
        }

        var q = quantize(raw, ctx);
        res.segs    = uniquify(q.segs);
        res.dropped = q.dropped;
        if (res.segs.length === 0) {
            res.error = "Every segment rounded to zero frames — nothing to queue.";
            return res;
        }
        return res;
    }

    // ── shared UI helper ──────────────────────────────────────────────────────

    function dimPen(ui, rgb) {
        return ui.graphics.newPen(ui.graphics.PenType.SOLID_COLOR, rgb, 1);
    }

    function labelledRow(parent, text, labelWidth) {
        var g = parent.add("group");
        g.orientation = "row";
        g.spacing = 6;
        g.alignChildren = ["left", "center"];
        var lbl = g.add("statictext", undefined, text);
        lbl.preferredSize.width = labelWidth;
        return g;
    }

    // ── settings dialog ───────────────────────────────────────────────────────

    function showSettings() {
        var w = new Window("dialog", "Render Array — Settings");
        w.orientation   = "column";
        w.alignChildren = ["fill", "top"];
        w.spacing = 10;
        w.margins = 18;

        // ---- output location ----
        var locPanel = w.add("panel", undefined, "Output location");
        locPanel.orientation   = "column";
        locPanel.alignChildren = ["fill", "top"];
        locPanel.spacing = 8;
        locPanel.margins = [12, 16, 12, 12];

        var rbProject = locPanel.add("radiobutton", undefined, "Beside the project file");

        var projRow   = labelledRow(locPanel, "        Folder:", 90);
        var inRenders = projRow.add("edittext", undefined, S.rendersFolderPref);
        inRenders.preferredSize.width = 120;
        var fallLbl   = projRow.add("statictext", undefined, "or, if it exists:");
        var inFall    = projRow.add("edittext", undefined, S.rendersFolderFall);
        inFall.preferredSize.width = 100;

        var rbCustom  = locPanel.add("radiobutton", undefined, "Custom folder");

        var custRow   = labelledRow(locPanel, "        Path:", 90);
        var inCustom  = custRow.add("edittext", undefined, S.customFolder);
        inCustom.preferredSize.width = 300;
        var btnBrowse = custRow.add("button", undefined, "Browse…");
        btnBrowse.preferredSize.width = 80;

        var subRow   = labelledRow(locPanel, "Subfolder:", 90);
        var inSubPat = subRow.add("edittext", undefined, S.subfolderPattern);
        inSubPat.preferredSize.width = 200;
        var subHint  = subRow.add("statictext", undefined, "blank = none");
        subHint.graphics.foregroundColor = dimPen(subHint, [0.5, 0.5, 0.5]);

        var tokHint = locPanel.add("statictext", undefined,
            "{id}  {version}  {prefix}  {base}  {comp}  {date}      \"/\" nests folders. " +
            "Empty tokens drop their own separator.", { multiline: true });
        tokHint.preferredSize = [470, 28];
        tokHint.graphics.foregroundColor = dimPen(tokHint, [0.5, 0.5, 0.5]);

        var pathPreview = locPanel.add("statictext", undefined, "", { truncate: "middle" });
        pathPreview.preferredSize.width = 470;
        pathPreview.graphics.foregroundColor = dimPen(pathPreview, [0.55, 0.75, 1.0]);

        rbProject.value = (S.outputMode !== "custom");
        rbCustom.value  = !rbProject.value;

        // ---- output modules ----
        var omPanel = w.add("panel", undefined, "Output modules");
        omPanel.orientation   = "column";
        omPanel.alignChildren = ["fill", "top"];
        omPanel.spacing = 6;
        omPanel.margins = [12, 16, 12, 12];

        var extRow   = labelledRow(omPanel, "Video ext:", 110);
        var inExt    = extRow.add("edittext", undefined, S.outputExtension);
        inExt.preferredSize.width = 70;
        var snapExt  = extRow.add("statictext", undefined, "     Snapshot ext:");
        var inSnapExt = extRow.add("edittext", undefined, S.snapshotExtension);
        inSnapExt.preferredSize.width = 70;

        var rsRow    = labelledRow(omPanel, "Render settings:", 110);
        var inRS     = rsRow.add("edittext", undefined, S.renderSettings);
        inRS.preferredSize.width = 200;
        var rsHint   = rsRow.add("statictext", undefined, "blank = AE default");
        rsHint.graphics.foregroundColor = dimPen(rsHint, [0.5, 0.5, 0.5]);

        var otRow    = labelledRow(omPanel, "Output module:", 110);
        var inOT     = otRow.add("edittext", undefined, S.outputTemplate);
        inOT.preferredSize.width = 200;
        var otHint   = otRow.add("statictext", undefined, "blank = AE default");
        otHint.graphics.foregroundColor = dimPen(otHint, [0.5, 0.5, 0.5]);

        var stRow    = labelledRow(omPanel, "Snapshot module:", 110);
        var inST     = stRow.add("edittext", undefined, S.snapshotTemplate);
        inST.preferredSize.width = 200;
        var stHint   = stRow.add("statictext", undefined, "blank = first PNG template");
        stHint.graphics.foregroundColor = dimPen(stHint, [0.5, 0.5, 0.5]);

        // ---- markers ----
        var mkPanel = w.add("panel", undefined, "Markers");
        mkPanel.orientation   = "column";
        mkPanel.alignChildren = ["fill", "top"];
        mkPanel.spacing = 6;
        mkPanel.margins = [12, 16, 12, 12];

        // checkbox · contains/starts-with · needle — shared by ignore and alert
        function filterRow(label, on, mode, text) {
            var row = mkPanel.add("group");
            row.orientation = "row";
            row.spacing = 6;
            row.alignChildren = ["left", "center"];
            var cb = row.add("checkbox", undefined, label);
            cb.preferredSize.width = 210;
            cb.value = on;
            var dd = row.add("dropdownlist", undefined, ["contains", "starts with"]);
            dd.preferredSize.width = 100;
            dd.selection = (mode === "startswith") ? 1 : 0;
            var inp = row.add("edittext", undefined, text);
            inp.preferredSize.width = 70;
            return { cb: cb, dd: dd, inp: inp };
        }

        var ign      = filterRow("Ignore markers whose comment",
                                 S.ignoreMarkers, S.ignoreMarkerMode, S.ignoreMarkerText);
        var cbIgnore = ign.cb, ddMode = ign.dd, inIgnore = ign.inp;

        var ignHint = mkPanel.add("statictext", undefined,
            "Ignored markers are skipped entirely — Marker to Marker spans straight over them. " +
            "Markers with no comment are never ignored.",
            { multiline: true });
        ignHint.preferredSize = [470, 28];
        ignHint.graphics.foregroundColor = dimPen(ignHint, [0.5, 0.5, 0.5]);

        // ---- defaults ----
        var defPanel = w.add("panel", undefined, "Defaults");
        defPanel.orientation   = "column";
        defPanel.alignChildren = ["fill", "top"];
        defPanel.spacing = 6;
        defPanel.margins = [12, 16, 12, 12];

        var durRow  = labelledRow(defPanel, "Segment duration:", 110);
        var inDur   = durRow.add("edittext", undefined, S.defaultDuration);
        inDur.preferredSize.width = 70;
        var durHint2 = durRow.add("statictext", undefined, "(e.g. 3s, 3.5s, 90f)");
        durHint2.graphics.foregroundColor = dimPen(durHint2, [0.5, 0.5, 0.5]);

        var cbRemember = defPanel.add("checkbox", undefined,
            "Remember the last duration and In / Out setting I used");
        cbRemember.value = S.rememberLastUsed;

        // ---- buttons ----
        var btnRow = w.add("group");
        btnRow.orientation = "row";
        btnRow.alignChildren = ["left", "center"];
        btnRow.spacing = 8;

        var btnReset = btnRow.add("button", undefined, "Restore Defaults");
        var gap = btnRow.add("group");
        gap.alignment = "fill";
        var btnCancelS = btnRow.add("button", undefined, "Cancel", { name: "cancel" });
        var btnSave    = btnRow.add("button", undefined, "Save",   { name: "ok" });

        // ---- behaviour ----

        function syncEnabled() {
            inRenders.enabled = rbProject.value;
            inFall.enabled    = rbProject.value;
            fallLbl.enabled   = rbProject.value;
            inCustom.enabled  = rbCustom.value;
            btnBrowse.enabled = rbCustom.value;
            ddMode.enabled    = cbIgnore.value;
            inIgnore.enabled  = cbIgnore.value;
            updatePreview();
        }

        // Preview against the real comp when there is one, else a placeholder
        // that exercises every token so the pattern can be read before use.
        var SAMPLE_COMP = "010_ID1000_A1_ElementName_v001";

        function updatePreview() {
            var saved = {
                outputMode       : S.outputMode,
                customFolder     : S.customFolder,
                rendersFolderPref: S.rendersFolderPref,
                rendersFolderFall: S.rendersFolderFall,
                subfolderPattern : S.subfolderPattern
            };
            S.outputMode        = rbCustom.value ? "custom" : "project";
            S.customFolder      = inCustom.text;
            S.rendersFolderPref = trim(inRenders.text) || DEFAULTS.rendersFolderPref;
            S.rendersFolderFall = trim(inFall.text)    || DEFAULTS.rendersFolderFall;
            S.subfolderPattern  = trim(inSubPat.text);

            var name = compIsValid() ? compName : SAMPLE_COMP;
            var out  = outputFolderPath(name);
            pathPreview.text = out.error
                ? "⚠ " + out.error
                : "→ " + out.path + "/" + (compIsValid() ? "" : "   (example)");

            for (var k in saved) { if (saved.hasOwnProperty(k)) S[k] = saved[k]; }
        }

        rbProject.onClick = syncEnabled;
        rbCustom.onClick  = syncEnabled;
        cbIgnore.onClick  = syncEnabled;
        inRenders.onChanging = updatePreview;
        inFall.onChanging    = updatePreview;
        inCustom.onChanging  = updatePreview;
        inSubPat.onChanging  = updatePreview;

        btnBrowse.onClick = function () {
            var start = trim(inCustom.text) ? new Folder(trim(inCustom.text)) : null;
            var picked = Folder.selectDialog("Choose an output folder", start);
            if (picked) {
                inCustom.text  = picked.fsName;
                rbCustom.value = true;
                syncEnabled();
            }
        };

        btnReset.onClick = function () {
            rbProject.value = (DEFAULTS.outputMode !== "custom");
            rbCustom.value  = !rbProject.value;
            inRenders.text  = DEFAULTS.rendersFolderPref;
            inFall.text     = DEFAULTS.rendersFolderFall;
            inCustom.text   = DEFAULTS.customFolder;
            inSubPat.text   = DEFAULTS.subfolderPattern;
            inExt.text      = DEFAULTS.outputExtension;
            inSnapExt.text  = DEFAULTS.snapshotExtension;
            inRS.text       = DEFAULTS.renderSettings;
            inOT.text       = DEFAULTS.outputTemplate;
            inST.text       = DEFAULTS.snapshotTemplate;
            cbIgnore.value  = DEFAULTS.ignoreMarkers;
            ddMode.selection = (DEFAULTS.ignoreMarkerMode === "startswith") ? 1 : 0;
            inIgnore.text   = DEFAULTS.ignoreMarkerText;
            inDur.text      = DEFAULTS.defaultDuration;
            cbRemember.value = DEFAULTS.rememberLastUsed;
            syncEnabled();
        };

        var saved = false;
        btnSave.onClick = function () {
            if (rbCustom.value && !trim(inCustom.text)) {
                alert("Choose a custom output folder, or switch back to \"Beside the project file\".");
                return;
            }
            if (cbIgnore.value && !trim(inIgnore.text)) {
                alert("Enter the text to match on, or untick \"Ignore markers whose comment…\".");
                return;
            }
            // A pattern that is all tokens and resolves to nothing would dump
            // every comp into the output root without ever saying so. A blank
            // pattern means the same thing but is an explicit choice.
            if (trim(inSubPat.text)) {
                var savedPat = S.subfolderPattern;
                S.subfolderPattern = trim(inSubPat.text);
                var probe = resolveSubfolder(compIsValid() ? compName : SAMPLE_COMP);
                S.subfolderPattern = savedPat;
                if (!probe) {
                    alert("Subfolder \"" + trim(inSubPat.text) + "\" resolves to nothing for " +
                          (compIsValid() ? compName : SAMPLE_COMP) + ".\n\n" +
                          "Every comp would render straight into the output root. " +
                          "Clear the field if that is what you want.");
                    return;
                }
            }
            if (isNaN(parseSegDuration(inDur.text, 24))) {
                alert("\"" + trim(inDur.text) + "\" is not a valid default duration.\n" +
                      "Use something like 3s, 3.5s or 90f.");
                return;
            }
            S.outputMode        = rbCustom.value ? "custom" : "project";
            S.customFolder      = trim(inCustom.text).replace(/[\/\\]+$/, "");
            S.rendersFolderPref = trim(inRenders.text) || DEFAULTS.rendersFolderPref;
            S.rendersFolderFall = trim(inFall.text)    || DEFAULTS.rendersFolderFall;
            S.subfolderPattern  = trim(inSubPat.text);
            S.outputExtension   = normExt(inExt.text,     DEFAULTS.outputExtension);
            S.snapshotExtension = normExt(inSnapExt.text, DEFAULTS.snapshotExtension);
            S.renderSettings    = trim(inRS.text);
            S.outputTemplate    = trim(inOT.text);
            S.snapshotTemplate  = trim(inST.text);
            S.ignoreMarkers     = cbIgnore.value;
            S.ignoreMarkerMode  = (ddMode.selection.index === 1) ? "startswith" : "contains";
            S.ignoreMarkerText  = trim(inIgnore.text);
            S.defaultDuration   = trim(inDur.text);
            S.rememberLastUsed  = cbRemember.value;
            saveSettings(S);
            saved = true;
            w.close();
        };

        btnCancelS.onClick = function () { w.close(); };

        syncEnabled();
        w.show();
        return saved;
    }

    // ── ScriptUI panel/dialog ─────────────────────────────────────────────────
    // When hosted in AE (ScriptUI Panels folder), thisObj is the Panel.
    // When run via File > Scripts, thisObj is undefined — create a palette window.
    // To dock: put this file in Scripts/ScriptUI Panels/, restart AE, then open
    // it from the Window menu.

    S = loadSettings();

    var dlg = (thisObj instanceof Panel)
        ? thisObj
        : new Window("palette", "Render Array");   // not resizeable — fixed size
    dlg.orientation = "column";
    dlg.alignChildren = ["fill", "top"];
    dlg.spacing = 12;
    dlg.margins = 18;

    // One single-line label per row. A multiline statictext sized by hand
    // drops any line that doesn't fully fit rather than clipping it, which hid
    // every segment after A — single-line labels are sized by ScriptUI itself.
    // Skips the rebuild when the rows are unchanged — refresh() runs on every
    // keystroke in the duration box. Returns true if anything was rebuilt.
    function setRows(container, lines, rgb) {
        var i, t, key = lines.join("\n") + "|" + rgb.join(",");
        if (container.rowsKey === key) return false;
        container.rowsKey = key;
        while (container.children.length) container.remove(container.children[0]);
        for (i = 0; i < lines.length; i++) {
            t = container.add("statictext", undefined, lines[i], { truncate: "end" });
            t.alignment = ["fill", "top"];
            t.graphics.foregroundColor = dimPen(t, rgb);
        }
        return true;
    }

    function rowBox(parent, spacing) {
        var g = parent.add("group");
        g.orientation   = "column";
        g.alignChildren = ["fill", "top"];
        g.spacing = spacing;
        g.margins = 0;
        return g;
    }

    // layout(true) recomputes sizes after rows are rebuilt; resize() then fits
    // the children back to the panel's current bounds, which a docked panel
    // needs — it doesn't grow to fit its contents the way a palette does.
    function relayout() {
        try { dlg.layout.layout(true); dlg.layout.resize(); } catch (e) { /* not laid out yet */ }
    }

    // onResize fires once the drag ends — refit the table's columns then,
    // not on every step of the drag.
    dlg.onResizing = function () { this.layout.resize(); };
    dlg.onResize   = function () { this.layout.resize(); fitTable(); };

    // ── comp info ─────────────────────────────────────────────────────────────

    var infoGroup = dlg.add("group");
    infoGroup.orientation = "row";
    infoGroup.alignChildren = ["left", "center"];
    infoGroup.spacing = 14;

    var infoText = infoGroup.add("group");
    infoText.orientation = "column";
    infoText.alignChildren = ["fill", "top"];
    infoText.alignment = "fill";
    infoText.spacing = 2;

    var nameLabel = infoText.add("statictext", undefined, "—");
    nameLabel.graphics.font = ScriptUI.newFont("dialog", "BOLD", 11);

    var metaLabel = infoText.add("statictext", undefined, "—");
    metaLabel.graphics.foregroundColor = dimPen(metaLabel, [0.6, 0.6, 0.6]);

    var btnRefresh = infoGroup.add("button", undefined, "Refresh");
    btnRefresh.preferredSize.width = 110;
    btnRefresh.helpTip = "Refresh — click after switching comps";

    // Settings as a gear, top right. Drawn rather than a "⚙" glyph, which
    // some UI fonts don't have. Outlined so the centre hole needs no
    // background colour: a toothed rim plus a small ring. Brighter on hover.
    var btnSettings = infoGroup.add("button", undefined, "");
    btnSettings.preferredSize = [28, 28];
    btnSettings.maximumSize   = [28, 28];
    btnSettings.helpTip = "Settings — output folder, extensions, templates; saved across AE sessions";
    btnSettings.onDraw = function (state) {
        var g = this.graphics, cx = this.size.width / 2, cy = this.size.height / 2,
            lit = !this.enabled ? 0.35 : (state && state.mouseOver) ? 0.95 : 0.7,
            pen = g.newPen(g.PenType.SOLID_COLOR, [lit, lit, lit, 1], 1.5),
            TEETH = 8, R_ROOT = 6.5, R_TIP = 9, BASE = 0.24, TIP = 0.15, HOLE = 2.75,
            i, a, pts = [];
        // each tooth: root, tip, tip, root — the root-to-root lines between
        // teeth close the rim
        for (i = 0; i < TEETH; i++) {
            a = i * 2 * Math.PI / TEETH;
            pts.push([R_ROOT, a - BASE], [R_TIP, a - TIP], [R_TIP, a + TIP], [R_ROOT, a + BASE]);
        }
        g.newPath();
        g.moveTo(cx + Math.cos(pts[0][1]) * pts[0][0], cy + Math.sin(pts[0][1]) * pts[0][0]);
        for (i = 1; i < pts.length; i++) {
            g.lineTo(cx + Math.cos(pts[i][1]) * pts[i][0], cy + Math.sin(pts[i][1]) * pts[i][0]);
        }
        g.closePath();
        g.strokePath(pen);
        g.newPath();
        g.ellipsePath(cx - HOLE, cy - HOLE, HOLE * 2, HOLE * 2);
        g.strokePath(pen);
    };

    dlg.add("panel").minimumSize = [1, 1]; // divider

    // ── two columns: mode settings left, segment preview right ────────────────

    var mainRow = dlg.add("group");
    mainRow.orientation   = "row";
    mainRow.alignChildren = ["fill", "fill"];
    mainRow.spacing = 8;
    mainRow.margins = 0;

    // Fixed width on the left; the Segments panel takes whatever is left.
    var leftCol = mainRow.add("group");
    leftCol.orientation   = "column";
    leftCol.alignChildren = ["fill", "top"];
    leftCol.alignment     = ["left", "fill"];
    leftCol.preferredSize.width = CONFIG.leftColWidth;
    leftCol.spacing = 6;
    leftCol.margins = 0;

    // ── mode panel ────────────────────────────────────────────────────────────

    var modePanel = leftCol.add("panel", undefined, "Mode");
    modePanel.orientation = "column";
    modePanel.alignChildren = ["fill", "top"];
    modePanel.spacing = 5;
    modePanel.margins = [10, 12, 10, 8];

    var radios = [];
    for (var rbi = 0; rbi < MODES.length; rbi++) {
        radios.push(modePanel.add("radiobutton", undefined, MODES[rbi].label));
        radios[rbi].helpTip = MODES[rbi].desc;
    }

    // Describes the selected mode, under the radios so it reads as part of the
    // choice. Fixed at two lines, generously tall — a tight height would drop
    // the second line — so switching modes never shifts the layout.
    var descLabel = modePanel.add("statictext", undefined, "", { multiline: true });
    descLabel.preferredSize = [CONFIG.leftColWidth - 20, 40];   // minus panel margins
    descLabel.graphics.foregroundColor = dimPen(descLabel, [0.58, 0.58, 0.58]);

    // Always opens on Marker to Marker — deliberately not remembered.
    (function selectDefaultMode() {
        for (var i = 0; i < MODES.length; i++) {
            if (MODES[i].key === "m2m") { radios[i].value = true; return; }
        }
        radios[0].value = true;
    })();

    function currentMode() {
        for (var i = 0; i < radios.length; i++) { if (radios[i].value) return MODES[i]; }
        return MODES[0];
    }

    // ── options panel ─────────────────────────────────────────────────────────

    // Stretches to the bottom of the row so both columns end on the same line.
    var optPanel = leftCol.add("panel", undefined, "Options");
    optPanel.orientation   = "column";
    optPanel.alignChildren = ["fill", "top"];
    optPanel.alignment     = ["fill", "fill"];
    optPanel.spacing = 8;
    optPanel.margins = [10, 12, 10, 8];

    var durGroup = optPanel.add("group");
    durGroup.orientation = "row";
    durGroup.alignChildren = ["left", "center"];
    durGroup.spacing = 8;

    var durLabel = durGroup.add("statictext", undefined, "Duration");
    var durInput = durGroup.add("edittext", undefined, S.defaultDuration);
    durInput.preferredSize.width = 50;
    durInput.helpTip = "Seconds or frames: 3s, 3.5s, 90f";
    var durHint  = durGroup.add("statictext", undefined, "3s · 90f");
    durHint.graphics.foregroundColor = dimPen(durHint, [0.5, 0.5, 0.5]);

    // Applies to every mode, so it is an option rather than a mode.
    var cbWA = optPanel.add("checkbox", undefined, "Limit to In / Out points");
    cbWA.value   = S.useWorkArea;
    cbWA.helpTip = "Every mode works inside the work area as if it were the whole comp: " +
                   "markers outside it are skipped and the last segment runs to the Out point.";

    // ── range preview ─────────────────────────────────────────────────────────

    // A multi-column listbox: real columns with headers, and it scrolls, so
    // every segment is listed however many markers there are. The units button
    // switches Start / End / Duration between timeline frames and seconds.
    var segPanel = mainRow.add("panel", undefined, "Segments");
    segPanel.orientation   = "column";
    segPanel.alignChildren = ["fill", "top"];
    segPanel.alignment     = ["fill", "fill"];
    segPanel.spacing = 8;
    segPanel.margins = [10, 12, 10, 8];

    // Column widths are fixed once a listbox exists, so the table lives in its
    // own group and is rebuilt when it needs different ones: columns run the
    // full width while every row fits, and make room for the scrollbar only
    // once it appears — no empty strip down the right otherwise.
    var tableHost = segPanel.add("group");
    tableHost.orientation = "stack";
    tableHost.alignment   = ["fill", "fill"];
    tableHost.margins     = 0;

    var segList = null, segListCols = "", segRows = [];

    function tableColumnWidths(scroll) {
        var base = CONFIG.segColWidths, w = [], used = 0, avail, i,
            hostW = (tableHost.size && tableHost.size.width) ? tableHost.size.width : CONFIG.segListWidth;
        avail = hostW - CONFIG.segListChrome - (scroll ? CONFIG.segScrollbar : 0);
        for (i = 0; i < base.length; i++) { w.push(base[i]); used += base[i]; }
        // Shared evenly: the listbox draws no column dividers, so spare width
        // all on the last column reads as an empty strip down the right.
        var extra = Math.max(0, avail - used), each = Math.floor(extra / w.length);
        for (i = 0; i < w.length; i++) w[i] += each;
        w[w.length - 1] += extra - each * w.length;
        return w;
    }

    // Returns true when a new listbox went in, which needs a relayout.
    function ensureSegList(scroll) {
        var widths = tableColumnWidths(scroll), key = widths.join(",");
        if (segList && segListCols === key) return false;
        if (segList) tableHost.remove(segList);
        segList = tableHost.add("listbox", undefined, [], {
            numberOfColumns: 4,
            showHeaders    : true,
            columnTitles   : ["Segment", "Start", "End", "Duration"],
            columnWidths   : widths
        });
        segList.preferredSize = [CONFIG.segListWidth, CONFIG.segListHeight];
        segList.alignment     = ["fill", "fill"];
        segListCols = key;
        return true;
    }
    ensureSegList(false);

    // Under the table: notes on the left, a compact units toggle on the right.
    var segFoot = segPanel.add("group");
    segFoot.orientation   = "row";
    segFoot.alignChildren = ["left", "top"];
    segFoot.spacing = 8;
    segFoot.margins = 0;

    var rangeNote = rowBox(segFoot, 2);
    rangeNote.alignment = ["fill", "top"];

    var btnUnits = segFoot.add("button", undefined, "");
    btnUnits.preferredSize.width = 52;
    btnUnits.maximumSize.width   = 52;
    btnUnits.alignment = ["right", "top"];
    btnUnits.helpTip = "Table units — click to switch between frames and seconds";


    function syncUnitsButton() {
        btnUnits.text = (S.previewUnits === "seconds") ? "sec" : "fr";
    }
    syncUnitsButton();

    var GREY = [0.5, 0.5, 0.5];

    // ── output destination ────────────────────────────────────────────────────

    dlg.add("panel").minimumSize = [1, 1]; // divider

    // One row: caption, then the path filling the rest and truncating in the
    // middle. Shown from the project's folder down rather than from /Users/…,
    // so the part that differs between comps stays visible. Hover for the
    // absolute path.
    var outGroup = dlg.add("group");
    outGroup.orientation   = "row";
    outGroup.alignChildren = ["left", "center"];
    outGroup.alignment     = ["fill", "top"];
    outGroup.spacing = 8;
    outGroup.margins = 0;

    var outCaption = outGroup.add("statictext", undefined, "Output");
    outCaption.graphics.foregroundColor = dimPen(outCaption, [0.5, 0.5, 0.5]);

    var outLabel = outGroup.add("statictext", undefined, "", { truncate: "middle" });
    outLabel.alignment = ["fill", "center"];
    outLabel.preferredSize.width = 200;
    outLabel.graphics.foregroundColor = dimPen(outLabel, [0.55, 0.75, 1.0]);
    var outPath = "";


    // Result of the last queue, in place of the old modal summary.
    // Cleared by refresh() so a stale "queued" line can't be read as describing
    // whatever the panel is showing now.
    var msgBox    = rowBox(dlg, 6);
    var statusBox = rowBox(msgBox, 2);

    function setStatus(lines, warn) {
        setRows(statusBox, lines, warn ? [1.0, 0.72, 0.28] : [0.45, 0.85, 0.55]);
        relayout();
    }

    // Alert markers, listed rather than counted — they are the ones the user
    // asked to be told about. Driven by refresh(), not by queueing, so they are
    // visible before anything is rendered.
    var alertBox = rowBox(msgBox, 2);

    // ── actions ───────────────────────────────────────────────────────────────

    // Cancel on the far left (floating only); Reveal then the primary action
    // on the right, primary last. The primary label carries the segment count
    // (set by refresh()).
    var btnGroup = dlg.add("group");
    btnGroup.orientation   = "row";
    btnGroup.alignChildren = ["left", "center"];
    btnGroup.alignment     = ["fill", "top"];
    btnGroup.spacing = 8;
    btnGroup.margins = 0;

    var btnCancel = btnGroup.add("button", undefined, "Cancel");
    btnCancel.preferredSize.width = 90;
    btnCancel.maximumSize.width   = 90;
    if (dlg instanceof Panel) btnCancel.visible = false;   // nothing to close when docked

    var spacer = btnGroup.add("group");
    spacer.alignment = ["fill", "center"];

    var btnReveal = btnGroup.add("button", undefined, "Reveal");
    btnReveal.preferredSize.width = 80;
    btnReveal.maximumSize.width   = 80;
    btnReveal.alignment = ["right", "center"];
    btnReveal.helpTip = "Open the output folder in " + FILE_BROWSER + " — or the nearest part of it that exists yet";

    var btnOk = btnGroup.add("button", undefined, "Queue Segments");
    btnOk.preferredSize.width = 170;
    btnOk.maximumSize.width   = 170;
    btnOk.alignment = ["right", "center"];
    btnOk.active = true;

    function setQueueLabel(res, mode) {
        var n = (res && !res.error && res.segs) ? res.segs.length : 0;
        var noun = (mode && mode.key === "mkrsnap") ? "Snapshot" : "Segment";
        btnOk.text = n ? "Queue " + n + " " + noun + (n === 1 ? "" : "s") : "Queue " + noun + "s";
    }

    // "<project folder>/RENDERS/<comp>" when rendering beside the project,
    // else the absolute path with the home folder as "~".
    // fsName uses "\" on Windows while the path is joined with "/", so both
    // sides are compared with forward slashes.
    function fwd(x) { return String(x).replace(/\\/g, "/"); }

    function displayPath(p) {
        var base, home;
        p = fwd(p);
        if (S.outputMode !== "custom" && app.project.file) {
            base = app.project.file.parent.parent;
            if (base) {
                base = fwd(base.fsName);
                if (p.indexOf(base + "/") === 0) return p.substring(base.length + 1);
            }
        }
        try { home = fwd(Folder("~").fsName); } catch (e) { home = ""; }
        return (home && p.indexOf(home + "/") === 0) ? "~" + p.substring(home.length) : p;
    }

    btnReveal.onClick = function () {
        var f = outPath ? new Folder(outPath) : null;
        while (f && !f.exists) f = f.parent;
        if (f) f.execute();
    };

    var footerGroup = dlg.add("group");
    footerGroup.orientation = "row";
    footerGroup.alignment = "right";
    footerGroup.margins = 0;

    var footerLabel = footerGroup.add("statictext", undefined, "v" + VERSION + "  ·  Desmond Du");
    footerLabel.graphics.foregroundColor = dimPen(footerLabel, [0.4, 0.4, 0.4]);

    // ── refresh — description, destination, enable state and preview ──────────

    // Frame numbers follow the comp's start frame, as on the timeline.
    function frameNumber(t) {
        var first = 0;
        try { first = comp.displayStartFrame; } catch (e) { /* pre-2017 */ }
        return Math.round(t / comp.frameDuration) + first;
    }

    // Rows are only rebuilt when they change. The listbox keeps its size
    // whatever it holds, so filling it never needs a relayout.
    // Returns true when the listbox itself was replaced (needs a relayout);
    // refilling an existing one never does.
    function setTable(rows) {
        var i, j, it, key = [], rebuilt;
        segRows = rows;
        rebuilt = ensureSegList(rows.length > CONFIG.segListRows);
        for (i = 0; i < rows.length; i++) key.push(rows[i].join("\t"));
        key = key.join("\n");
        if (!rebuilt && segList.rowsKey === key) return false;
        segList.rowsKey = key;
        segList.removeAll();
        for (i = 0; i < rows.length; i++) {
            it = segList.add("item", rows[i][0]);
            for (j = 1; j < rows[i].length; j++) it.subItems[j - 1].text = rows[i][j];
        }
        return rebuilt;
    }

    // After the first layout and after a resize, the table's real width is
    // known — re-spread the columns across it.
    function fitTable() {
        if (setTable(segRows)) relayout();
    }

    // A snapshot has no duration worth showing, so that column gives its time.
    // Frames: End is the last frame rendered (inclusive), as on the timeline.
    // Seconds: End is where the span stops, as in the render queue. A snapshot
    // is a single frame, so its End is its Start either way.
    function segmentRow(sg) {
        var f0 = frameNumber(sg.start);
        if (S.previewUnits === "seconds") {
            return [sg.suffix, fmtTime(sg.start),
                    fmtTime(sg.snapshot ? sg.start : sg.start + sg.dur), fmtTime(sg.dur)];
        }
        return [sg.suffix, String(f0), String(f0 + sg.frames - 1), sg.frames + " fr"];
    }

    function showPreview(res) {
        var rows = [], notes = [], i, changed = false;
        for (i = 0; i < res.segs.length; i++) rows.push(segmentRow(res.segs[i]));
        if (setTable(rows)) changed = true;

        if (res.dropped > 0) {
            notes.push("⚠ " + plural(res.dropped, "zero-length segment") + " skipped.");
        }
        if (res.ignored > 0) {
            notes.push("· " + plural(res.ignored, "marker") + " ignored by the marker filter.");
        }
        if (res.outside > 0) {
            notes.push("· " + plural(res.outside, "marker") + " outside the In / Out points.");
        }
        if (res.span) notes.unshift(res.span);
        if (setRows(rangeNote, notes, GREY)) changed = true;
        return changed;
    }

    function clearPreview(msg) {
        var rebuilt = setTable([]);
        return setRows(rangeNote, msg ? [msg] : [], GREY) || rebuilt;
    }

    function alertLines(alerts) {
        if (!alerts.length) return [];
        var rows = ["⚑ " + plural(alerts.length, "alert marker") + " — not queued:"], i, n;
        n = Math.min(alerts.length, CONFIG.alertMaxRows);
        for (i = 0; i < n; i++) {
            rows.push("    " + fmtTime(alerts[i].time) + "   " + trim(alerts[i].label));
        }
        if (alerts.length > n) rows.push("    …and " + (alerts.length - n) + " more.");
        return rows;
    }

    // Output folder for the loaded comp. Resolving it can list the project
    // folder, so it is done on Refresh, after Settings and at queue time — not
    // on every keystroke in the duration box.
    var outCache = null;

    function resolveOutput() {
        outCache = compIsValid() ? outputFolderPath(compName) : null;
    }

    function refresh() {
        var changed = setRows(statusBox, [], GREY);
        var mode = currentMode();
        durLabel.enabled = mode.needsDur;
        durInput.enabled = mode.needsDur;
        durHint.enabled  = mode.needsDur;
        descLabel.text   = mode.desc;

        if (!compIsValid()) {
            setQueueLabel(null, mode);
            btnOk.enabled      = false;
            btnReveal.enabled  = false;
            outLabel.text      = "";
            outPath            = "";
            if (clearPreview("")) changed = true;
            if (setRows(alertBox, [], GREY)) changed = true;
            if (changed) relayout();
            return;
        }

        if (!outCache) resolveOutput();
        var out = outCache;
        outPath           = out.error ? "" : out.path;
        outLabel.text     = out.error ? "⚠ " + out.error : "→ " + displayPath(out.path) + "/";
        outLabel.helpTip  = out.error ? "" : out.path;
        btnReveal.enabled = !out.error;

        var ctx = compContext(comp, markers, cbWA.value);
        var res = buildSegments(mode.key, ctx, durInput.text);
        res.span = ctx.useWA ? "In / Out:  " + fmtTime(ctx.lo) + " → " + fmtTime(ctx.hi) : "";
        btnOk.enabled   = !res.error && !out.error;
        setQueueLabel(res, mode);
        if (res.error ? clearPreview("⚠ " + res.error + (res.span ? "   (" + res.span + ")" : ""))
                      : showPreview(res)) changed = true;
        if (setRows(alertBox, alertLines(ctx.alerts), [1.0, 0.45, 0.35])) changed = true;
        if (changed) relayout();
    }

    for (var rci = 0; rci < radios.length; rci++) { radios[rci].onClick = refresh; }
    cbWA.onClick = refresh;

    // Remembered across sessions — it's a viewing preference, not per-queue.
    btnUnits.onClick = function () {
        S.previewUnits = (S.previewUnits === "seconds") ? "frames" : "seconds";
        syncUnitsButton();
        saveSettings(S);
        refresh();
    };
    durInput.onChanging = refresh;

    btnSettings.onClick = function () {
        if (!showSettings()) return;
        resolveOutput();
        if (compIsValid()) updateMeta();   // filter counts may have changed
        refresh();
    };

    // ── loadComp — reads active comp, refreshes labels and preview ────────────

    function updateMeta() {
        var f = filterMarkers(markers), bits = [];
        if (f.ignored > 0)       bits.push(f.ignored + " ignored");
        if (f.alerts.length > 0) bits.push(plural(f.alerts.length, "alert"));
        metaLabel.text = "Duration: " + fmtTime(duration) + "   •   " + fmtFps(frameRate) +
                         " fps   •   " + plural(markers.length, "marker") +
                         (bits.length ? " (" + bits.join(", ") + ")" : "");
    }

    function loadComp() {
        var c = app.project.activeItem, ci, it;
        if (!(c instanceof CompItem)) {
            for (ci = 1; ci <= app.project.items.length; ci++) {
                it = app.project.items[ci];
                if (it instanceof CompItem && it.selected) { c = it; break; }
            }
        }

        if (!(c instanceof CompItem)) {
            comp      = null;
            compName  = "";
            duration  = 0;
            frameRate = 1;
            markers   = [];
            outCache  = null;
            nameLabel.text = "No composition selected";
            metaLabel.text = "Open or click a comp, then press Refresh";
            refresh();
            return;
        }

        comp      = c;
        compName  = c.name;
        duration  = c.duration;
        frameRate = c.frameRate;
        markers   = readMarkers(c);
        resolveOutput();

        nameLabel.text = "Comp: " + compName;
        updateMeta();
        refresh();
    }

    btnRefresh.onClick = loadComp;
    loadComp();

    // ── button handlers ───────────────────────────────────────────────────────

    btnCancel.onClick = function () {
        if (!(dlg instanceof Panel)) dlg.close();
    };

    btnOk.onClick = function () {

        if (!compIsValid()) {
            alert("No active composition found.\nPress Refresh, then try again.");
            loadComp();
            return;
        }

        // ── re-read the comp so a stale cache can never drive a render ────────

        compName  = comp.name;
        duration  = comp.duration;
        frameRate = comp.frameRate;
        markers   = readMarkers(comp);
        resolveOutput();
        var ctx   = compContext(comp, markers, cbWA.value);
        updateMeta();
        refresh();

        var mode = currentMode();
        var res  = buildSegments(mode.key, ctx, durInput.text);
        if (res.error) {
            alert(res.error + "\nAborting.");
            return;
        }

        // ── resolve output folder ─────────────────────────────────────────────

        var out = outCache;
        if (out.error) { alert(out.error + "\n\nAborting."); return; }

        var outDir = ensureFolder(out.path);
        if (!outDir) {
            alert("Could not create:\n" + out.path + "\n\nAborting.");
            return;
        }

        // ── add render queue items (all-or-nothing) ───────────────────────────

        var added        = [];
        var snapTemplate = null;
        var totalFrames  = 0;
        var overwrites   = 0;
        var clampedCount = 0;

        function pickSnapshotTemplate(om) {
            var t = om.templates, i;
            if (S.snapshotTemplate) {
                for (i = 0; i < t.length; i++) {
                    if (t[i] === S.snapshotTemplate) return t[i];
                }
                throw new Error("Snapshot output-module template \"" + S.snapshotTemplate +
                                "\" does not exist in this project.\n\nAvailable:\n" + t.join("\n"));
            }
            for (i = 0; i < t.length; i++) {
                if (CONFIG.snapshotAutoRx.test(t[i])) return t[i];
            }
            throw new Error("No PNG output-module template found in this project.\n" +
                            "Without one the item would render a movie named \"" +
                            S.snapshotExtension + "\".\n\n" +
                            "Create one (Output Module > PNG Sequence > Save As Template), " +
                            "or name one in Settings…");
        }

        try {
            for (var si = 0; si < res.segs.length; si++) {
                var seg      = res.segs[si];
                var ext      = seg.snapshot ? S.snapshotExtension : S.outputExtension;
                var fileName = safeFileStem(compName) + "_" + seg.suffix + ext;
                var outFile  = new File(outDir.fsName + "/" + fileName);
                var exists   = outFile.exists;

                var rqItem = app.project.renderQueue.items.add(comp);
                added.push(rqItem);
                rqItem.timeSpanStart    = seg.start;
                rqItem.timeSpanDuration = seg.dur;

                if (S.renderSettings) {
                    try { rqItem.applyTemplate(S.renderSettings); }
                    catch (eRS) {
                        throw new Error("Render-settings template \"" + S.renderSettings +
                                        "\" does not exist in this project.\nCheck Settings…");
                    }
                }

                var om = rqItem.outputModules[1];

                if (seg.snapshot) {
                    if (snapTemplate === null) { snapTemplate = pickSnapshotTemplate(om); }
                    om.applyTemplate(snapTemplate);
                } else if (S.outputTemplate) {
                    try { om.applyTemplate(S.outputTemplate); }
                    catch (eOT) {
                        throw new Error("Output-module template \"" + S.outputTemplate +
                                        "\" does not exist in this project.\nCheck Settings…");
                    }
                }

                om.file = outFile;

                // read the span back — AE clamps silently rather than erroring
                var gotStart = rqItem.timeSpanStart;
                var gotDur   = rqItem.timeSpanDuration;
                var clamped  = (Math.abs(gotStart - seg.start) > ctx.frameDur / 2) ||
                               (Math.abs(gotDur   - seg.dur)   > ctx.frameDur / 2);

                totalFrames += seg.frames;
                if (exists)  overwrites++;
                if (clamped) clampedCount++;
            }
        } catch (err) {
            for (var ri = added.length - 1; ri >= 0; ri--) {
                try { added[ri].remove(); } catch (e2) { /* already gone */ }
            }
            alert("Could not queue segments:\n\n" + err.toString() +
                  "\n\nNothing was added to the render queue.");
            return;
        }

        // ── remember what was used ────────────────────────────────────────────

        if (S.rememberLastUsed) {
            S.defaultDuration = trim(durInput.text);
            S.useWorkArea     = cbWA.value;
            saveSettings(S);
        }

        // ── report inline and hand over to the render queue ───────────────────

        var notes = [];
        if (overwrites   > 0) notes.push(plural(overwrites, "file") + " overwritten");
        if (clampedCount > 0) notes.push(plural(clampedCount, "span") + " clamped by AE");
        if (res.dropped  > 0) notes.push(plural(res.dropped, "zero-length segment") + " skipped");
        if (res.ignored  > 0) notes.push(plural(res.ignored, "marker") + " ignored by the filter");
        if (res.outside  > 0) notes.push(plural(res.outside, "marker") + " outside the In / Out points");
        if (ctx.alerts.length > 0) notes.push(plural(ctx.alerts.length, "alert marker") + " not queued — see below");

        var statusLines = ["✓ Queued " + plural(added.length, "item") + " · " +
                           plural(totalFrames, "frame") + " — not yet rendering."];
        for (var ni = 0; ni < notes.length; ni++) statusLines.push("⚠ " + notes[ni] + ".");
        setStatus(statusLines, notes.length > 0);

        // showWindow(true) is idempotent. The Window > Render Queue menu command
        // is a toggle, so it would close an already-open panel — only fall back
        // to it if the scripting call is unavailable.
        try {
            app.project.renderQueue.showWindow(true);
        } catch (eShow) {
            try { app.executeCommand(app.findMenuCommandId("Render Queue")); }
            catch (eCmd) { /* panel stays where it is; items are queued regardless */ }
        }
    };

    // ── width lock ────────────────────────────────────────────────────────────

    // Contents are locked to CONFIG.panelWidth. The floating palette is
    // created without resizeable, so it is fixed at its content size in both
    // directions — on Windows, min/max sizes alone don't stop a resizeable
    // window being dragged. A docked panel's frame is AE's to size, so there
    // the contents hold their size: extra space is left empty, and a smaller
    // dock clips rather than squeezes.
    (function lockWidth() {
        var m = dlg.margins, inner, i;
        inner = CONFIG.panelWidth - ((m.left !== undefined) ? m.left + m.right : 2 * m);
        for (i = 0; i < dlg.children.length; i++) {
            dlg.children[i].minimumSize.width = inner;
            dlg.children[i].maximumSize.width = inner;
        }
    })();

    // ── show (floating mode only) ─────────────────────────────────────────────

    // The table's real width only exists after the first layout, so its
    // columns are spread across it then.
    if (dlg instanceof Panel) {
        dlg.layout.layout(true);
        dlg.layout.resize();
        fitTable();
    } else {
        dlg.onShow = fitTable;
        dlg.show();
    }

})(this);
