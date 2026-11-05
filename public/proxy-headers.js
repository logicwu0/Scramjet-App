// The pinned proxy's cookie parser decodes percent-encoded cookie values.
// Restore non-ByteString characters before bare-mux constructs a Request.
// Do not alter Authorization or other application headers.
self.webvpnNormalizeProxyHeaders = function (headers) {
	const repaired = [];
	for (const name of Object.keys(headers)) {
		if (name.toLowerCase() !== "cookie") continue;
		const value = headers[name];
		if (typeof value !== "string" || !/[^\x00-\xff]/u.test(value)) continue;
		headers[name] = value.replace(/[^\x00-\xff]+/gu, (part) =>
			Array.from(new TextEncoder().encode(part), (byte) =>
				"%" + byte.toString(16).toUpperCase().padStart(2, "0")
			).join("")
		);
		repaired.push(name);
	}
	return repaired;
};
