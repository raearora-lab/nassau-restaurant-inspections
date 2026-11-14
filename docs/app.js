(function () {
  "use strict";
  var NSHARD = 256, PAGE = 150;
  var C = {}; // column index
  var rows = [], byId = {}, viol = null, shardCache = {}, filtered = [], shown = 0;
  var map, cluster, markers = {}, highlight = null, lastListScroll = 0;
  var $ = function (id) { return document.getElementById(id); };

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
  var MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  function fdate(d) { if (!d) return "—"; var p = d.split("-"); return MON[+p[1] - 1] + " " + (+p[2]) + ", " + p[0]; }
  function nameCase(s) {
    // Records are upper case; soften for display but keep short tokens like "BBQ" readable.
    return String(s).toLowerCase().replace(/(^|[\s\-\/&(."@])([a-z])/g, function (m, a, b) { return a + b.toUpperCase(); })
      .replace(/'S\b/g, "'s").replace(/\b(Llc|Inc|Ii|Iii|Bbq|Nyc|Usa|Ny)\b/g, function (m) { return m.toUpperCase(); });
  }
  function statusBadge(open) { return open ? '<span class="badge b-open">Open</span>' : '<span class="badge b-closed">Closed</span>'; }
  function gradeBadge(g, unofficial) {
    if (!g) return "";
    return '<span class="badge b-' + g + '" title="Grade written in inspector comments, not an official grade field">Grade ' + g +
      (unofficial ? " · unofficial" : "") + "</span>";
  }
  function resultBadge(grade, crit) {
    if (crit == null && !grade) return "";
    if (grade) return gradeBadge(grade, true);
    if (crit > 0) return '<span class="badge b-crit">' + crit + " critical</span>";
    return '<span class="badge b-clean">Clean</span>';
  }
  function inspType(t) { return t === "R" ? "Re-inspection" : "Inspection"; }
  function getJSON(u) { return fetch(u).then(function (r) { if (!r.ok) throw new Error(u + " " + r.status); return r.json(); }); }

  // ---------- map ----------
  function initMap() {
    map = L.map("map", { preferCanvas: true, zoomControl: true }).setView([40.73, -73.59], 11);
    // CARTO dark_all currently serves only "API KEY REQUIRED" watermark tiles.
    // Esri World Dark Gray is a free, keyless dark basemap with no watermark.
    // Native tiles stop at zoom 16 ("Map data not yet available" above that), so overzoom past 16.
    var esriAttr = 'Tiles &copy; <a href="https://www.esri.com/">Esri</a>';
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 18,
      maxNativeZoom: 16,
      attribution: esriAttr
    }).addTo(map);
    map.createPane("labels");
    map.getPane("labels").style.zIndex = 450;
    map.getPane("labels").style.pointerEvents = "none";
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 18,
      maxNativeZoom: 16,
      pane: "labels",
      attribution: esriAttr
    }).addTo(map);
    cluster = L.markerClusterGroup({
      chunkedLoading: true,
      showCoverageOnHover: false,
      maxClusterRadius: 50,
      spiderfyOnMaxZoom: true,
      disableClusteringAtZoom: 18,
      iconCreateFunction: function (cl) {
        var n = cl.getChildCount();
        var size = n < 25 ? "small" : n < 100 ? "medium" : "large";
        var dim = size === "small" ? 36 : size === "medium" ? 44 : 54;
        return L.divIcon({ html: "<span>" + n + "</span>", className: "nri-cluster nri-cluster-" + size, iconSize: L.point(dim, dim) });
      }
    });
    map.addLayer(cluster);
  }
  function markerFor(r) {
    var id = r[C.id];
    if (markers[id]) return markers[id];
    var color = !r[C.open] ? "#8a8a94" : r[C.grade] === "A" ? "#c8ff00" : r[C.grade] === "B" ? "#3d7eff" : r[C.grade] === "C" ? "#ff2d6a" : "#00ffd0";
    var m = L.circleMarker([r[C.lat], r[C.lon]], { radius: 6, weight: 1.5, color: "#000", fillColor: color, fillOpacity: 1 });
    m.bindPopup(function () {
      var lastc = C.lastc != null ? r[C.lastc] : null;
      var lastn = C.lastn != null ? r[C.lastn] : null;
      var typ = C.lastt != null ? r[C.lastt] : "";
      var counts = lastc == null ? "" : (lastc + " critical · " + lastn + " non-critical");
      return '<a href="#/r/' + id + '">' + esc(nameCase(r[C.name])) + "</a><br>" + esc(r[C.addr]) + ", " + esc(r[C.city]) +
        "<br>" + statusBadge(r[C.open]) + resultBadge(r[C.grade], lastc) +
        '<br><span class="r-latest">Latest ' + fdate(r[C.last]) + (typ ? " · " + inspType(typ) : "") +
        (counts ? " · " + counts : "") + "</span>";
    });
    markers[id] = m;
    return m;
  }
  function drawMarkers() {
    cluster.clearLayers();
    var ms = [];
    for (var i = 0; i < filtered.length; i++) { var r = filtered[i]; if (r[C.lat] != null) ms.push(markerFor(r)); }
    cluster.addLayers(ms);
  }

  // ---------- filters / list ----------
  function norm(s) { return String(s).toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim(); }
  function applyFilters() {
    var q = norm($("q").value), town = $("f-town").value, st = $("f-status").value, g = $("f-grade").value,
        ty = $("f-type").value, crit = $("f-crit").checked, sort = $("f-sort").value;
    var terms = q ? q.split(" ") : [];
    filtered = rows.filter(function (r) {
      if (st === "open" && !r[C.open]) return false;
      if (st === "closed" && r[C.open]) return false;
      if (town && r[C.city] !== town) return false;
      if (g === "none" ? r[C.grade] : (g && r[C.grade] !== g)) return false;
      if (ty && r[C.type] !== ty) return false;
      if (crit && !(r[C.crit3] > 0)) return false;
      if (terms.length) { var hay = r._s; for (var i = 0; i < terms.length; i++) if (hay.indexOf(terms[i]) < 0) return false; }
      return true;
    });
    if (sort === "recent") filtered.sort(function (a, b) { return (b[C.last] || "").localeCompare(a[C.last] || ""); });
    else if (sort === "crit3") filtered.sort(function (a, b) { return b[C.crit3] - a[C.crit3] || (b[C.last] || "").localeCompare(a[C.last] || ""); });
    var unpinned = filtered.filter(function (r) { return r[C.lat] == null; }).length;
    $("result-count").textContent = filtered.length.toLocaleString() + " of " + rows.length.toLocaleString() + " places" +
      (unpinned ? " · " + unpinned.toLocaleString() + " not on map (location unknown)" : "");
    $("results").innerHTML = ""; shown = 0; renderMore();
    drawMarkers();
  }
  function renderMore() {
    var html = [], end = Math.min(filtered.length, shown + PAGE);
    for (var i = shown; i < end; i++) {
      var r = filtered[i];
      var lastc = C.lastc != null ? r[C.lastc] : null;
      var lastn = C.lastn != null ? r[C.lastn] : null;
      var typ = C.lastt != null ? r[C.lastt] : "";
      html.push('<li><a href="#/r/' + r[C.id] + '"><div class="r-name">' + esc(nameCase(r[C.name])) + statusBadge(r[C.open]) +
        '</div><div class="r-latest">' + fdate(r[C.last]) + (typ ? " · " + inspType(typ) : "") + " " + resultBadge(r[C.grade], lastc) +
        (lastc > 0 ? "" : (lastn > 0 ? '<span class="muted"> · ' + lastn + " non-critical</span>" : "")) +
        '</div><div class="r-meta">' + (r[C.op] ? esc(nameCase(r[C.op])) + "<br>" : "") + esc(r[C.addr]) + ", " + esc(r[C.city]) +
        " · " + r[C.insp] + " inspection" + (r[C.insp] === 1 ? "" : "s") +
        (r[C.crit3] ? ' · <span class="b-crit">' + r[C.crit3] + " critical in last 3 yrs</span>" : "") + "</div></a></li>");
    }
    $("results").insertAdjacentHTML("beforeend", html.join(""));
    shown = end;
    $("more").hidden = shown >= filtered.length;
  }

  // ---------- detail ----------
  function loadShard(id) {
    var k = id % NSHARD;
    if (!shardCache[k]) shardCache[k] = getJSON("data/d/" + k + ".json");
    var v = viol ? Promise.resolve(viol) : getJSON("data/viol.json").then(function (x) { viol = x; return x; });
    return Promise.all([shardCache[k], v]).then(function (a) { return a[0][String(id)]; });
  }
  function renderViolations(x) {
    var v = x[7] || [];
    var parts = [];
    if (v.length) {
      parts.push('<ul class="vlist">');
      v.forEach(function (it) {
        parts.push('<li class="' + (it[2] ? "crit" : "") + '">' + (it[2] ? '<span class="ct">Critical</span>' : "") +
          '<span class="code">' + esc(it[0]) + "</span>" + esc(viol[it[1]] || "") + "</li>");
      });
      parts.push("</ul>");
    } else if (!x[2] && !x[3]) {
      parts.push('<div class="none">No violations recorded.</div>');
    } else {
      parts.push('<div class="none">Violation details were not itemized in the source data.</div>');
    }
    if (x[6]) parts.push('<p class="cmt"><span class="cmt-l">Inspector comments</span>' + esc(x[6]) + "</p>");
    return parts.join("");
  }
  function renderInsp(x) {
    return '<div class="insp"><div class="insp-h"><span><span class="date">' + fdate(x[0]) + "</span> · " + inspType(x[1]) +
      gradeBadge(x[5], true) + '</span><span class="cnt">' + x[2] + " critical" +
      (x[4] ? " (" + x[4] + " not corrected on site)" : "") + " · " + x[3] + " non-critical</span></div>" +
      renderViolations(x) + "</div>";
  }
  function showDetail(id) {
    $("list-pane").hidden = true;
    var pane = $("detail-pane"); pane.hidden = false;
    pane.innerHTML = '<p class="muted">Loading inspection history…</p>';
    $("sidebar").scrollTop = 0;
    loadShard(id).then(function (d) {
      if (!d) { pane.innerHTML = '<a class="back" href="#/">← All places</a><p>No record found for this ID.</p>'; return; }
      var open = d.s === "A";
      document.title = nameCase(d.n) + " · Nassau County Restaurant Inspections";
      var crit = 0, crit3 = 0, n3 = 0, cutoff = "2023-11-09";
      d.i.forEach(function (x) { crit += x[2]; if (x[0] >= cutoff) { crit3 += x[2]; n3++; } });
      var latest = d.i.length ? d.i[0] : null;
      var tone = !latest ? "" : (latest[2] > 0 ? " latest-crit" : " latest-clean");
      var h = ['<a class="back" href="#/">← All places</a>',
        '<h1 class="d-name">' + esc(nameCase(d.n)) + "</h1>",
        '<p class="d-addr">' + esc(d.a) + ", " + esc(d.c) + " " + esc(d.z) + "<br>" + statusBadge(open) + "</p>"];
      if (latest) {
        h.push('<section class="latest-panel' + tone + '">',
          '<p class="eyebrow">Latest inspection</p>',
          '<div class="latest-date">' + fdate(latest[0]) + "</div>",
          '<p class="latest-type">' + inspType(latest[1]) +
            (latest[5] ? " " + gradeBadge(latest[5], true) : " " + resultBadge("", latest[2])) + "</p>",
          '<div class="facts">',
          '<div class="fact ' + (latest[2] > 0 ? "fact-pink" : "fact-lime") + '"><b>' + latest[2] + "</b><span>critical violations</span></div>",
          '<div class="fact fact-teal"><b>' + latest[3] + "</b><span>non-critical violations</span></div>",
          (latest[4] ? '<div class="fact fact-pink"><b>' + latest[4] + "</b><span>critical not corrected on site</span></div>" : ""),
          "</div>");
        if (latest[5]) {
          h.push('<p class="unofficial-note">The letter grade is unofficial. It was written in the inspector’s comments; NYS DOH does not collect this data as a grading system.</p>');
        }
        h.push(renderViolations(latest), "</section>");
      } else {
        h.push('<section class="latest-panel"><p class="eyebrow">Latest inspection</p><p class="muted">No inspections in the source files.</p></section>');
      }
      h.push('<h3 class="sec">On record</h3>',
        '<div class="facts">',
        '<div class="fact fact-lime"><b>' + d.i.length + "</b><span>inspections on record</span></div>",
        '<div class="fact fact-pink"><b>' + crit + "</b><span>critical violations, all time</span></div>",
        '<div class="fact fact-pink"><b>' + crit3 + "</b><span>critical violations, last 3 years (" + n3 + " inspection" + (n3 === 1 ? "" : "s") + ")</span></div>",
        '<div class="fact fact-teal"><b>' + (d.i.length ? fdate(d.i[d.i.length - 1][0]) : "—") + "</b><span>first record</span></div>",
        "</div>",
        '<dl class="kv">',
        "<dt>Type</dt><dd>" + esc(d.t) + "</dd>",
        d.op ? "<dt>Permit name</dt><dd>" + esc(d.op) + "</dd>" : "",
        d.dba ? "<dt>Doing business as</dt><dd>" + esc(d.dba) + "</dd>" : "",
        d.corp ? "<dt>Operator</dt><dd>" + esc(d.corp) + "</dd>" : "",
        "<dt>Town</dt><dd>" + esc(d.m) + "</dd>",
        d.pe ? "<dt>Permit expires</dt><dd>" + fdate(d.pe) + "</dd>" : "",
        "<dt>NYS operation ID</dt><dd>" + esc(id) + (d.fc ? " · facility code " + esc(d.fc) : "") + "</dd>",
        "</dl>");
      if (!d.ll) h.push('<p class="muted">This address could not be placed on the map.</p>');
      if (d.same && d.same.length) {
        h.push('<div class="note"><strong>Same location history.</strong> ' + d.same.length + " other permit" + (d.same.length === 1 ? "" : "s") +
          " share this address or facility code. That can mean a change of owner or name, or another kitchen at the same site.<ul>");
        d.same.slice(0, 25).forEach(function (o) {
          h.push('<li><a href="#/r/' + o[0] + '">' + esc(nameCase(o[1])) + "</a> " + statusBadge(o[2] === "A") +
            ' <span class="muted">' + (o[3] ? o[3].slice(0, 4) : "?") + "–" + (o[2] === "A" ? "present" : (o[4] ? o[4].slice(0, 4) : "?")) + "</span></li>");
        });
        if (d.same.length > 25) h.push("<li class='muted'>and " + (d.same.length - 25) + " more</li>");
        h.push("</ul></div>");
      }
      var earlier = d.i.slice(1);
      if (earlier.length) {
        h.push('<details class="history"><summary>Earlier inspections <span class="hist-n">' + earlier.length + "</span></summary>");
        earlier.forEach(function (x) { h.push(renderInsp(x)); });
        h.push("</details>");
      } else if (d.i.length) {
        h.push('<p class="muted">No earlier inspections on record.</p>');
      }
      h.push('<p class="muted foot-note">From NYS DOH public records through Nov 6, 2026. An inspection shows conditions on one day only. Grades are taken from inspector comments, not an official grade field. <a href="#/about">About the data</a></p>');
      pane.innerHTML = h.join("");
      $("sidebar").scrollTop = 0; window.scrollTo(0, 0);
      focusOnMap(id, d);
    }).catch(function (e) { pane.innerHTML = '<a class="back" href="#/">← All places</a><p>Could not load this record (' + esc(e.message) + ").</p>"; });
  }
  function focusOnMap(id, d) {
    if (highlight) { map.removeLayer(highlight); highlight = null; }
    if (!d.ll) return;
    highlight = L.circleMarker(d.ll, { radius: 12, weight: 3, color: "#c8ff00", fill: false, opacity: 1 }).addTo(map);
    map.setView(d.ll, Math.max(map.getZoom(), 16));
  }

  // ---------- browse ----------
  var listsLoaded = false;
  function renderBrowse() {
    if (listsLoaded) return; listsLoaded = true;
    getJSON("data/lists.json").then(function (L_) {
      function item(x, extra) {
        var lastc = x.length > 10 ? x[10] : null;
        return '<li><a href="#/r/' + x[0] + '">' + esc(nameCase(x[1])) + "</a>" + statusBadge(x[3]) +
          '<div class="r-latest">' + fdate(x[5]) + " " + resultBadge(x[4], lastc) + "</div>" +
          '<span class="m">' + (x[9] ? esc(nameCase(x[9])) + " · " : "") + esc(x[2]) + (extra ? " · " + extra : "") + "</span></li>";
      }
      var h = ['<div class="lists">'];
      h.push('<section class="lcard"><h2>Recent inspections</h2><p class="desc">The most recently inspected places in the records.</p><ol>' +
        L_.recent.map(function (x) { return item(x, x[8] + " inspection" + (x[8] === 1 ? "" : "s") + " on record"); }).join("") + "</ol></section>");
      h.push('<section class="lcard"><h2>Most critical violations, last 3 years</h2><p class="desc">Open places with the most critical violations cited since Nov 9, 2023. Many were corrected during the visit.</p><ol>' +
        L_.crit3.map(function (x) { return item(x, x[6] + " critical in last 3 yrs"); }).join("") + "</ol></section>");
      h.push('<section class="lcard"><h2>Latest grade C</h2><p class="desc">Places whose most recent grade written in inspector comments was C. Open and closed places are both listed.</p><ol>' +
        L_.latestC.map(function (x) { return item(x, x[8] + " inspection" + (x[8] === 1 ? "" : "s") + " on record"); }).join("") + "</ol></section>");
      h.push('<section class="lcard"><h2>Changed hands at the same address</h2><p class="desc">Open restaurants and other food businesses at addresses where two or more earlier food businesses had permits.</p><ol>' +
        L_.turnover.map(function (t) {
          var last = t.length > 6 ? t[6] : "";
          var grade = t.length > 7 ? t[7] : "";
          var lastc = t.length > 8 ? t[8] : null;
          return '<li><a href="#/r/' + t[0] + '">' + esc(nameCase(t[1])) + "</a>" +
            (last ? '<div class="r-latest">' + fdate(last) + " " + resultBadge(grade, lastc) + "</div>" : "") +
            '<span class="m">' + esc(t[2]) + ", " + esc(t[3]) + " · " + t[4] + " earlier: " +
            esc(t[5].map(nameCase).join(", ")) + (t[4] > t[5].length ? "…" : "") + "</span></li>";
        }).join("") + "</ol></section>");
      h.push("</div>");
      $("browse-lists").innerHTML = h.join("");
    }).catch(function () { $("browse-lists").textContent = "Could not load lists."; });
  }

  // ---------- routing ----------
  function route() {
    var h = location.hash || "#/";
    var m = h.match(/^#\/r\/(\d+)/);
    var view = h.indexOf("#/browse") === 0 ? "browse" : h.indexOf("#/about") === 0 ? "about" : "map";
    $("view-map").hidden = view !== "map"; $("view-browse").hidden = view !== "browse"; $("view-about").hidden = view !== "about";
    Array.prototype.forEach.call(document.querySelectorAll("nav a"), function (a) { a.classList.toggle("active", a.getAttribute("data-nav") === view); });
    if (view === "map") {
      setTimeout(function () { map.invalidateSize(); }, 0);
      if (m) { lastListScroll = lastListScroll || $("sidebar").scrollTop; showDetail(+m[1]); }
      else {
        document.title = "Nassau County Restaurant Inspections, 2001–2026";
        $("detail-pane").hidden = true; $("list-pane").hidden = false;
        if (highlight) { map.removeLayer(highlight); highlight = null; }
        $("sidebar").scrollTop = lastListScroll; lastListScroll = 0;
      }
    } else {
      window.scrollTo(0, 0);
      if (view === "browse") renderBrowse();
      document.title = (view === "browse" ? "Browse" : "About the data") + " · Nassau County Restaurant Inspections";
    }
  }

  // ---------- boot ----------
  initMap();
  window.addEventListener("hashchange", route);
  route();
  getJSON("data/index.json").then(function (ix) {
    ix.cols.forEach(function (c, i) { C[c] = i; });
    rows = ix.rows;
    var towns = {};
    rows.forEach(function (r) { r._s = norm(r[C.name] + " " + r[C.op] + " " + r[C.addr] + " " + r[C.city]); byId[r[C.id]] = r; if (r[C.city]) towns[r[C.city]] = (towns[r[C.city]] || 0) + 1; });
    $("f-town").insertAdjacentHTML("beforeend", Object.keys(towns).sort().map(function (t) { return '<option value="' + esc(t) + '">' + esc(t) + "</option>"; }).join(""));
    var t; $("q").addEventListener("input", function () { clearTimeout(t); t = setTimeout(applyFilters, 180); });
    ["f-town", "f-status", "f-grade", "f-type", "f-crit", "f-sort"].forEach(function (id) { $(id).addEventListener("change", applyFilters); });
    $("more").addEventListener("click", renderMore);
    applyFilters();
  }).catch(function (e) { $("result-count").textContent = "Could not load data: " + e.message; });
})();
