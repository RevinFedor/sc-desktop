`ts-fsrs-5.4.1.js` is the MIT-licensed UMD distribution of ts-fsrs 5.4.1,
matching Voice Record's installed dependency. The license is alongside it.
The algorithm is unchanged. The only distribution patch registers the factory's
exports on `globalThis.FSRS` even through the CommonJS branch: Vite can wrap Study's
UMD inputs in a shared CommonJS scope, while the extension worker uses globals.
The browser projection takes its card and parameters from Voice; the server
replays the real answer times and remains the canonical owner.
Update the distribution together with Voice's dependency, then run parity and
production-bundle checks; passing a source-only build does not verify UMD wiring.
