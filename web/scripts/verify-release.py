"""Side-panel and real fake-backend smoke checks. See RELEASE-VERIFICATION.md."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "docs" / "harbor-verification"
SCENARIOS = ["payments_pool", "ams_db_outage", "auth_attack", "network_partition"]
DOMAINS = ["database", "database", "security", "networking"]
CREW = [["Zak", "Maya", "Alex", "Jordan"], ["Zak", "Maya", "Riley", "Jordan"], ["Sam", "Jordan"], ["Zak", "Riley", "Jordan"]]


def check_layout(page):
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    assert page.locator(".building-sign").count() == 5
    assert page.evaluate("""() => [...document.querySelectorAll('.evidence-message')].filter(e=>e.getBoundingClientRect().width).every(e=>e.getBoundingClientRect().width > 200)""")
    assert page.evaluate("""() => [...document.querySelectorAll('.side-evidence,.side-ledger,.crew-panel')].filter(e=>e.getBoundingClientRect().width).every(e=>e.scrollWidth <= e.clientWidth+1)""")


with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge", headless=True)
    results = []
    for source in ["replay", "ws"]:
        for width, height in [(1440, 900), (1920, 1080)]:
            for index, scenario in enumerate(SCENARIOS):
                page = browser.new_page(viewport={"width": width, "height": height})
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.goto(f"http://127.0.0.1:5188/?source={source}&speed=1000")
                page.wait_for_function("window.__mayday?.store.getState().incident?.status === 'healthy'")
                page.locator("#tab-evidence").click()
                evidence = page.locator(".side-evidence")
                for tab in ["Logs", "Metrics", "Services", "Changes"]:
                    evidence.get_by_role("tab", name=tab, exact=True).click()
                    expect(evidence).to_contain_text("Trigger an incident")
                    expect(evidence.locator(".evidence-log li")).to_have_count(0)
                page.locator("#tab-ledger").click()
                expect(page.locator(".side-ledger")).not_to_contain_text("Task Board")
                page.locator("#tab-inbox").click()
                page.locator(".inbox-card").nth(index).get_by_role("button").click()
                page.wait_for_function("window.__mayday.store.getState().incident?.notification?.status === 'disabled'")
                state = page.evaluate("window.__mayday.store.getState()")
                incident = state["incident"]
                assert incident["commander"]["domain"] == DOMAINS[index]
                assert [person["name"] for person in incident["responders"]["responders"] if person["selected"]] == CREW[index]
                assert [repair["sandbox"]["passed"] for repair in incident["repairs"]] == [False, True]
                expected_steps = incident["repairs"][-1]["sandbox"]["steps"]
                expect(page.locator(f'[data-domain="{DOMAINS[index]}"] .building-status')).to_contain_text("ACTIVE")
                if scenario == "payments_pool":
                    expect(page.locator('[data-domain="payments"] .building-status')).to_contain_text("MONITORING")
                page.locator("#tab-evidence").click()
                evidence.get_by_role("tab", name="Logs", exact=True).click()
                expect(evidence.locator(".evidence-important").first).to_be_visible()
                assert evidence.locator(".evidence-important").count() > 0
                search = evidence.get_by_label("Search evidence logs")
                search.fill("no-matching-line-xyz")
                expect(evidence).to_contain_text("No matching evidence lines")
                search.fill("")
                evidence.get_by_label("Filter log severity").select_option("ERROR")
                assert all("evidence-error" in row.get_attribute("class") for row in evidence.locator(".evidence-log li").all())
                evidence.get_by_label("Filter log severity").select_option("ALL")
                details = evidence.locator(".evidence-message details").first
                details.locator("summary").click()
                expect(details.locator("code")).to_be_visible()
                check_layout(page)
                evidence.scroll_into_view_if_needed()
                if source == "replay" and scenario == "payments_pool":
                    page.screenshot(path=str(OUT / f"release-logs-{width}.png"))
                evidence.get_by_role("button", name="Pause", exact=True).click()
                paused_count = evidence.locator(".evidence-log li").count()
                page.locator("#tab-crew").click()
                expect(page.locator(".notification-status")).to_contain_text("Disabled")
                expect(page.locator(".crew-list")).to_contain_text("Not alerted")
                page.get_by_role("button", name="Approve repair", exact=True).click()
                page.wait_for_function("window.__mayday.store.getState().history.length === 1")
                completed = page.evaluate("window.__mayday.store.getState()")
                restored = completed["incident"]["restored"]
                assert restored["steps"] == expected_steps
                assert all(check["passed"] for check in restored["verification"])
                assert restored["rep_changes"]
                assert completed["history"][0]["mttrMs"] == restored["mttr_ms"]
                timer = page.locator(".incident-timer b").inner_text()
                page.wait_for_timeout(300)
                expect(page.locator(".incident-timer b")).to_have_text(timer)
                expect(page.locator(".header-facts")).to_contain_text("Simulated cost")
                page.locator("#tab-evidence").click()
                expect(evidence.locator(".evidence-log li")).to_have_count(paused_count)
                evidence.get_by_role("button", name="Resume", exact=True).click()
                assert evidence.locator(".evidence-log li").count() > paused_count
                for tab in ["Metrics", "Services", "Changes"]:
                    evidence.get_by_role("tab", name=tab, exact=True).click()
                    expect(evidence.locator('[role="tabpanel"]')).not_to_be_empty()
                    if tab == "Metrics":
                        expect(evidence).to_contain_text("Before:")
                        expect(evidence).not_to_contain_text("Pending")
                    if tab == "Services":
                        expect(evidence).to_contain_text("Healthy / restored")
                    check_layout(page)
                page.locator("#tab-crew").click()
                expect(page.locator(".crew-list")).not_to_contain_text("Watching")
                page.locator(".crew-panel").scroll_into_view_if_needed()
                check_layout(page)
                page.locator("#tab-ledger").click()
                ledger = page.locator(".side-ledger")
                expect(ledger).to_contain_text("Model Market")
                expect(ledger).to_contain_text("Task Board")
                expect(ledger).to_contain_text("Recovery verified")
                expect(ledger).to_contain_text("Specialist routes contacted / skipped")
                expect(ledger.locator("details pre")).not_to_be_visible()
                ledger.scroll_into_view_if_needed()
                check_layout(page)
                if source == "replay" and scenario == "payments_pool":
                    page.screenshot(path=str(OUT / f"release-ledger-{width}.png"))
                page.locator("#tab-inbox").click()
                page.locator(".inbox-card").nth(index).get_by_role("button", name="Run again").click()
                page.wait_for_function("window.__mayday.store.getState().incident?.status === 'awaiting_approval' && !!window.__mayday.store.getState().incident?.notification")
                page.get_by_role("button", name="Approve repair", exact=True).click()
                page.wait_for_function("window.__mayday.store.getState().history.length === 2")
                assert page.evaluate("window.__mayday.store.getState().history[1]") == completed["history"][0]
                page.get_by_role("button", name="Reset", exact=True).click()
                page.wait_for_function("window.__mayday.store.getState().incident?.status === 'healthy'")
                expect(page.locator(".incident-timer b")).to_have_text("00:00")
                page.locator("#tab-evidence").click()
                expect(evidence).to_contain_text("Trigger an incident")
                assert page.evaluate("window.__mayday.store.getState().history.length") == 2
                assert not errors, errors
                results.append({"source": source, "scenario": scenario, "viewport": f"{width}x{height}", "passed": True})
                print(f"PASS {source} {scenario} {width}x{height}", flush=True)
                page.close()
    browser.close()
    (OUT / "release-results.json").write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
