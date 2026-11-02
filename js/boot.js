// v0.5.22: load the localStorage overflow store (js/lsx.js) before any app module reads localStorage.
await (await import('./lsx.js')).ready;
await import('./app.js');
