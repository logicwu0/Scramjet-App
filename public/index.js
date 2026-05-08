"use strict";
/**
 * @type {HTMLFormElement}
 */
const form = document.getElementById("sj-form");
/**
 * @type {HTMLInputElement}
 */
const address = document.getElementById("sj-address");
/**
 * @type {HTMLInputElement}
 */
const searchEngine = document.getElementById("sj-search-engine");
/**
 * @type {HTMLParagraphElement}
 */
const error = document.getElementById("sj-error");
/**
 * @type {HTMLPreElement}
 */
const errorCode = document.getElementById("sj-error-code");
const landing = document.querySelector(".landing");

const { ScramjetController } = $scramjetLoadController();

const scramjet = new ScramjetController({
	prefix: "/web/",
	files: {
		wasm: "/scram/scramjet.wasm.wasm",
		all: "/scram/scramjet.all.js",
		sync: "/scram/scramjet.sync.js",
	},
});

const scramjetReady = Promise.resolve(scramjet.init());

const connection = new BareMux.BareMuxConnection("/baremux/worker.js");

let currentFrame = null;
let transportPromise = null;

function hashFromUrl(url) {
	return "#" + encodeURIComponent(url);
}

function urlFromHash() {
	return location.hash ? decodeURIComponent(location.hash.slice(1)) : "";
}

function setLandingHidden(hidden) {
	if (hidden) document.documentElement.classList.add("has-hash");
	else document.documentElement.classList.remove("has-hash");
}

function createOverlay() {
	let el = document.getElementById("initial-loading");
	if (!el || !el.isConnected) {
		el = document.createElement("div");
		el.className = "loading-overlay";
		el.textContent = "加载中…";
		document.body.appendChild(el);
	}
	return {
		hide() {
			if (!el.isConnected) return;
			el.classList.add("is-hiding");
			setTimeout(() => el.remove(), 150);
		},
	};
}

async function configureTransport() {
	const wispUrl =
		(location.protocol === "https:" ? "wss" : "ws") +
		"://" +
		location.host +
		"/wisp/";
	// Load custom CA certificate from server (place your .pem file in certs/cacert.pem)
	const pemFiles = [];
	try {
		const res = await fetch("/api/cacert");
		if (res.ok) {
			const pem = await res.text();
			pemFiles.push(pem);
			console.log(`[cacert] loaded ${pem.length} bytes from /api/cacert`);
		} else {
			console.log(`[cacert] /api/cacert returned ${res.status}`);
		}
	} catch (e) {
		console.warn("[cacert] fetch failed:", e);
	}
	// libcurl transport (commented out — switched to epoxy for large cert support)
	// const transportOpts = { websocket: wispUrl, verbose: true };
	// if (pemFiles[0]) transportOpts.cacert = pemFiles[0];
	// await connection.setTransport("/libcurl/index.mjs", [transportOpts]);
	console.log(
		`[transport] setting epoxy, wisp=${wispUrl}, pem_files=${pemFiles.length}`
	);
	await connection.setTransport("/epoxy/index.mjs", [
		{ wisp: wispUrl, pem_files: pemFiles },
	]);
	console.log("[transport] epoxy set OK");
}

function ensureTransport() {
	if (!transportPromise) transportPromise = configureTransport();
	return transportPromise;
}

function watchForFirstContent(iframe, onContent, maxMs = 10000) {
	const start = Date.now();
	let cancelled = false;
	function tick() {
		if (cancelled) return;
		if (Date.now() - start > maxMs) return;
		const doc = iframe.contentDocument;
		const url = doc && doc.URL;
		const isBlank = !url || url === "about:blank";
		if (!isBlank && doc.body && doc.body.firstChild) {
			onContent();
			return;
		}
		requestAnimationFrame(tick);
	}
	requestAnimationFrame(tick);
	return () => {
		cancelled = true;
	};
}

async function loadIntoFrame(url) {
	const overlay = createOverlay();

	try {
		await registerSW();
	} catch (err) {
		error.textContent = "Failed to register service worker.";
		errorCode.textContent = err.toString();
		setLandingHidden(false);
		overlay.hide();
		throw err;
	}

	try {
		await scramjetReady;
		await ensureTransport();
	} catch (err) {
		console.error("[transport] setTransport failed:", {
			name: err && err.name,
			message: err && err.message,
			ctor: err && err.constructor && err.constructor.name,
			stack: err && err.stack,
			cause: err && err.cause,
		});
		error.textContent = "Failed to set transport.";
		errorCode.textContent = err && err.toString ? err.toString() : String(err);
		transportPromise = null;
		setLandingHidden(false);
		overlay.hide();
		throw err;
	}

	console.log(`[nav] go -> ${url}`);

	if (!currentFrame) {
		const frame = scramjet.createFrame();
		frame.frame.id = "sj-frame";
		frame.addEventListener("urlchange", (ev) => {
			const newHash = hashFromUrl(ev.url);
			if (location.hash !== newHash) {
				history.replaceState({ url: ev.url }, "", newHash);
			}
		});
		document.body.appendChild(frame.frame);
		setLandingHidden(true);
		currentFrame = frame;
	}

	// Hide overlay the moment iframe paints its first content (mirrors black-screen progressive reveal).
	// Fall back to load event in case the polling somehow misses the transition.
	watchForFirstContent(currentFrame.frame, overlay.hide);
	currentFrame.frame.addEventListener("load", overlay.hide, { once: true });
	currentFrame.go(url);
}

function teardownFrame() {
	if (currentFrame) {
		currentFrame.frame.remove();
		currentFrame = null;
	}
	setLandingHidden(false);
}

form.addEventListener("submit", (event) => {
	event.preventDefault();
	const url = search(address.value, searchEngine.value);
	history.pushState({ url }, "", hashFromUrl(url));
	loadIntoFrame(url);
});

window.addEventListener("popstate", () => {
	const url = urlFromHash();
	if (!url) {
		teardownFrame();
	} else if (currentFrame) {
		currentFrame.go(url);
	} else {
		loadIntoFrame(url);
	}
});

const initialHashUrl = urlFromHash();
if (initialHashUrl) {
	loadIntoFrame(initialHashUrl);
}

window.addEventListener("unhandledrejection", (ev) => {
	const r = ev.reason;
	console.error("[page] unhandledrejection", {
		name: r && r.name,
		message: r && r.message,
		ctor: r && r.constructor && r.constructor.name,
		stack: r && r.stack,
		cause: r && r.cause,
	});
});
