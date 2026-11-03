"use strict";

const accountLink = document.createElement("a");
accountLink.href = "/auth/account";
accountLink.textContent = "账户 / 退出";
accountLink.style.cssText =
	"position:fixed;right:16px;top:12px;z-index:2147483647;background:white;color:#123;padding:8px 12px;border:1px solid #ccd;border-radius:6px";
document.body.appendChild(accountLink);

async function checkLogin() {
	try {
		const response = await fetch("/auth/session", { cache: "no-store" });
		if (response.status === 401) location.replace("/auth/login");
	} catch {
		// Server-side WebSocket expiry remains authoritative during network outages.
	}
}
checkLogin();
setInterval(checkLogin, 30000);
