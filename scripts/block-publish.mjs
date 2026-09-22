console.error(
	"Refusing to publish jev-browser-skill. At cline/plugins commit 96bde661f630ec23c1ce0cd86a2361a9959ef65a the root LICENSE is Apache-2.0 (Copyright 2026 Cline Bot Inc.) and plugins/jev-browser/package.json says MIT. This package stays private until upstream clarifies which license applies to that plugin. See NOTICE.",
);
process.exit(1);
