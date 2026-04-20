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

const { ScramjetController } = $scramjetLoadController();

const scramjet = new ScramjetController({
	files: {
		wasm: "/scram/scramjet.wasm.wasm",
		all: "/scram/scramjet.all.js",
		sync: "/scram/scramjet.sync.js",
	},
});

scramjet.init();

const connection = new BareMux.BareMuxConnection("/baremux/worker.js");

form.addEventListener("submit", async (event) => {
	event.preventDefault();

	try {
		await registerSW();
	} catch (err) {
		error.textContent = "Failed to register service worker.";
		errorCode.textContent = err.toString();
		throw err;
	}

	const url = search(address.value, searchEngine.value);

	let wispUrl =
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
	console.log(`[transport] setting epoxy, wisp=${wispUrl}, pem_files=${pemFiles.length}`);
	try {
		await connection.setTransport("/epoxy/index.mjs", [
			{ wisp: wispUrl, pem_files: pemFiles },
		]);
		console.log("[transport] epoxy set OK");
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
		throw err;
	}
	console.log(`[nav] go -> ${url}`);
	const frame = scramjet.createFrame();
	frame.frame.id = "sj-frame";
	document.body.appendChild(frame.frame);
	frame.go(url);
});

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
