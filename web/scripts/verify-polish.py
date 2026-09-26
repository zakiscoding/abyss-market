"""Repeatable desktop checks using recorded events and the real gated replay UI.

Run Vite on port 5173, install Python playwright, then run this script.
Uses installed Microsoft Edge; no Discord or backend connection is made.
"""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "docs" / "harbor-verification"
SCENARIOS = ["payments_pool", "ams_db_outage", "auth_attack", "network_partition"]
SIZES = [(1440, 900), (1920, 1080)]


def geometry(page):
    findings = page.evaluate("""() => {
      const errors = [];
      const rect = e => e.getBoundingClientRect();
      const overlap = (a,b) => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
      if (document.documentElement.scrollWidth > innerWidth) errors.push('horizontal overflow');
      const signs = [...document.querySelectorAll('.building-sign')];
      if (signs.length !== 5) errors.push('stall count');
      const art = rect(document.querySelector('.harbor-art'));
      for (const sign of signs) {
        const r = rect(sign);
        if (r.left < art.left || r.right > art.right || r.top < art.top || r.bottom > art.bottom) errors.push('stall outside artwork');
      }
      const labels = [...document.querySelectorAll('.building-sign,.building-status,.harbor-workflow li,.boat-captain,.harbor-sandbox,.harbor-caption')];
      for (let i = 0; i < labels.length; i++) for (let j = i+1; j < labels.length; j++) {
        if (overlap(rect(labels[i]),rect(labels[j]))) errors.push('overlap: '+labels[i].className+' / '+labels[j].className);
      }
      for (const b of document.querySelectorAll('.harbor-workflow b')) {
        if (b.scrollWidth > b.clientWidth) errors.push('stage text clipped: '+b.textContent);
      }
      const captain = rect(document.querySelector('.boat-captain'));
      const x = (captain.left + captain.width/2 - art.left)/art.width;
      if (Math.abs(x - .365) > .005) errors.push('captain detached from boat');
      const facts = [...document.querySelectorAll('.header-facts > *, .incident-timer, .header-actions')];
      for (let i=0;i<facts.length;i++) for(let j=i+1;j<facts.length;j++) {
        if(overlap(rect(facts[i]),rect(facts[j]))) errors.push('header overlap');
      }
      return errors;
    }""")
    assert not findings, findings


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel="msedge", headless=True)
    results = []
    for width, height in SIZES:
        for scenario in SCENARIOS:
            page = browser.new_page(viewport={"width": width, "height": height})
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            url = "http://127.0.0.1:5173/?source=replay&speed=1000"
            page.goto(url)
            page.wait_for_function("window.__mayday?.store.getState().incident?.status === 'healthy'")
            geometry(page)
            events = json.loads((ROOT / "fixtures" / f"incident_{scenario}.json").read_text(encoding="utf-8"))
            # Stop at actual recorded milestones to inspect brief intermediate states.
            cursor = 0
            checkpoints = []
            for index, event in enumerate(events):
                if event["type"] in ["incident_received", "commander_classified", "won", "sandbox_result", "approval_required", "approval_granted", "final"]:
                    page.evaluate("events => events.forEach(window.__mayday.store.dispatch)", events[cursor:index + 1])
                    cursor = index + 1
                    page.wait_for_timeout(40)
                    geometry(page)
                    checkpoints.append(event["type"] + (":" + str(event["data"]["passed"]) if event["type"] == "sandbox_result" else ""))
            expect(page.locator(".incident-timer b")).to_have_text("01:09")
            expect(page.locator(".header-facts .status")).to_have_count(0)
            expect(page.locator(".building-worker")).to_have_count(1)
            if scenario == "payments_pool":
                expect(page.locator('[data-domain="payments"] .building-status')).to_have_text("RECOVERY CONFIRMED")
            page.screenshot(path=str(OUTPUT / f"polish-{scenario}-{width}.png"))
            # Real replay controls: hold, decline, resume, approve, repeat and reset.
            page.reload()
            page.wait_for_function("window.__mayday?.store.getState().incident?.status === 'healthy'")
            index = SCENARIOS.index(scenario)
            card = page.locator(".inbox-card").nth(index)
            card.get_by_role("button", name="Trigger", exact=True).click()
            page.wait_for_function("window.__mayday.store.getState().incident?.status === 'awaiting_approval' && window.__mayday.store.getState().incident?.approval !== null")
            page.get_by_role("tab", name="Inbox", exact=True).click()
            for button in page.locator(".inbox-card button").all():
                expect(button).to_be_disabled()
            page.locator("#tab-crew").click()
            page.get_by_role("button", name="Request revision", exact=True).click()
            expect(page.get_by_role("button", name="Approve repair", exact=True)).to_be_disabled()
            geometry(page)
            page.get_by_role("button", name="Resume review", exact=True).click()
            page.get_by_role("button", name="Reject repair", exact=True).click()
            expect(page.get_by_role("button", name="Approve repair", exact=True)).to_be_disabled()
            geometry(page)
            page.get_by_role("button", name="Resume review", exact=True).click()
            page.get_by_role("button", name="Approve repair", exact=True).click()
            page.wait_for_function("window.__mayday.store.getState().history.length === 1")
            expect(page.locator(".incident-timer b")).to_have_text("01:09")
            geometry(page)
            crew = page.evaluate("window.__mayday.store.getState().history[0].crew")
            for tab in ["Crew", "Evidence", "Ledger", "Inbox"]:
                page.locator(f"#tab-{tab.lower()}").click()
                expect(page.locator(f'#panel-{tab.lower()}')).to_be_visible()
                if tab == "Crew":
                    for person in crew:
                        expect(page.locator(".crew-list")).to_contain_text(person["state"])
                    assert "Watching" not in page.locator(".crew-list").inner_text()
                geometry(page)
            for person in crew:
                expect(page.locator(".history-list")).to_contain_text(f'{person["name"]}: {person["state"]}')
            first = page.evaluate("window.__mayday.store.getState().history[0]")
            card.get_by_role("button", name="Run again", exact=True).click()
            page.wait_for_function("window.__mayday.store.getState().incident?.status === 'awaiting_approval' && window.__mayday.store.getState().incident?.approval !== null")
            page.get_by_role("button", name="Approve repair", exact=True).click()
            page.wait_for_function("window.__mayday.store.getState().history.length === 2")
            assert page.evaluate("window.__mayday.store.getState().history[1]") == first
            page.get_by_role("button", name="Reset", exact=True).click()
            page.wait_for_function("window.__mayday.store.getState().incident?.status === 'healthy'")
            expect(page.locator(".incident-timer b")).to_have_text("00:00")
            assert page.evaluate("window.__mayday.store.getState().history.length") == 2
            geometry(page)
            assert not errors, errors
            results.append({"scenario": scenario, "viewport": f"{width}x{height}", "milestones": checkpoints,
                            "controls": "revision, reject, resume, approve, run again, reset", "passed": True})
            print(f"PASS {scenario} {width}x{height}", flush=True)
            page.close()
    browser.close()
    (OUTPUT / "polish-results.json").write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
