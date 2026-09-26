"""The simulated incidents MAYDAY can run. Every number is derived from plain state."""
from __future__ import annotations

from .incident import Scenario, action, check, metric

MAX_ERROR_RATE = 0.01
MAX_P95_MS = 300
MIN_SUCCESS = 0.99


class PaymentsPoolExhaustion(Scenario):
    """A config change shrinks the payments DB connection pool from 20 to 2."""

    scenario_id = "payments_pool"
    name = "Payments API · DB pool exhaustion"
    service = "payments-api"
    region = "iad"
    source_system = "Datadog APM"
    alert = "payments-api HTTP 500 rate above 1% for 3 minutes"
    allowed_actions = ("set_db_pool_size", "restart_service", "rollback_config")
    decoy_plan = [action("restart_service")]
    fix_plan = [action("set_db_pool_size", value=20)]
    fake_diagnosis = (
        "Root cause: config change cfg-2291 cut db.pool.max_size from 20 to 2. "
        "Evidence: the pool is fully in use, requests time out acquiring a DB "
        "connection, and HTTP 500s began right after the change. Impact: most "
        "payment submissions fail."
    )

    HEALTHY_POOL = 20
    BROKEN_POOL = 2
    PEAK_CONNECTIONS = 18
    REQUESTS_PER_MIN = 1200
    PAYMENT_SHARE = 0.5
    BASE_P95_MS = 120
    SATURATION_P95_MS = 4800
    BASE_ERROR_RATE = 0.002
    SATURATION_ERROR_RATE = 0.6
    POOL_KEY = "db.pool.max_size"
    # Assumed average checkout value, used only to express failed payments in dollars.
    AVG_ORDER_USD = 42

    def _reset_state(self) -> None:
        self.pool_size = self.HEALTHY_POOL
        self.restarts = 0

    def _break(self) -> None:
        self.pool_size = self.BROKEN_POOL
        self.changes.append({
            "change_id": "cfg-2291",
            "key": self.POOL_KEY,
            "old": str(self.HEALTHY_POOL),
            "new": str(self.BROKEN_POOL),
            "author": "deploy-bot",
            "minutes_ago": 4,
        })

    def _state(self) -> dict:
        in_use = min(self.pool_size, self.PEAK_CONNECTIONS)
        shortfall = 1 - in_use / self.PEAK_CONNECTIONS
        error_rate = round(self.BASE_ERROR_RATE + shortfall * self.SATURATION_ERROR_RATE, 4)
        return {
            "in_use": in_use,
            "error_rate": error_rate,
            "p95": round(self.BASE_P95_MS + shortfall * self.SATURATION_P95_MS),
            "success": round(1 - error_rate, 4),
            "timeouts": round(self.REQUESTS_PER_MIN * shortfall * self.SATURATION_ERROR_RATE),
            "failed_payments": round(self.REQUESTS_PER_MIN * self.PAYMENT_SHARE * error_rate),
        }

    def telemetry(self) -> list[dict]:
        s = self._state()
        return [
            metric("error_rate", "HTTP 500 rate", s["error_rate"], "ratio", s["error_rate"] <= MAX_ERROR_RATE),
            metric("p95_latency_ms", "p95 latency", s["p95"], "ms", s["p95"] <= MAX_P95_MS),
            metric("payment_success_rate", "Payment success", s["success"], "ratio", s["success"] >= MIN_SUCCESS),
            metric("failed_payments_per_min", "Failed payments", s["failed_payments"], "per_min",
                   s["error_rate"] <= MAX_ERROR_RATE),
            metric("db_timeouts_per_min", "DB timeouts", s["timeouts"], "per_min", s["timeouts"] == 0),
            metric("db_pool_size", "DB pool size", self.pool_size, "count", s["timeouts"] == 0),
        ]

    def health_checks(self) -> list[dict]:
        s = self._state()
        return [
            check("error rate", s["error_rate"] <= MAX_ERROR_RATE,
                  f"{s['error_rate']:.1%} (limit {MAX_ERROR_RATE:.0%})"),
            check("p95 latency", s["p95"] <= MAX_P95_MS, f"{s['p95']} ms (limit {MAX_P95_MS} ms)"),
            check("payment success", s["success"] >= MIN_SUCCESS,
                  f"{s['success']:.1%} (min {MIN_SUCCESS:.0%})"),
            check("connection timeouts", s["timeouts"] == 0, f"{s['timeouts']}/min"),
        ]

    def _apply_step(self, step: dict) -> None:
        if step["action"] == "set_db_pool_size":
            self._record_change(self.POOL_KEY, str(self.pool_size), str(step["value"]))
            self.pool_size = step["value"]
        elif step["action"] == "restart_service":
            # A restart re-reads the same config, so a bad pool size survives it.
            self.restarts += 1
        elif step["action"] == "rollback_config" and self.changes:
            last = self.changes.pop()
            if last["key"] == self.POOL_KEY:
                self.pool_size = int(last["old"])

    def logs(self) -> list[str]:
        s = self._state()
        if self.healthy():
            return [
                f"INFO  {self.service} p95={s['p95']}ms errors={s['error_rate']:.1%} "
                f"pool={s['in_use']}/{self.pool_size}",
                f"INFO  payments processed {round(self.REQUESTS_PER_MIN * self.PAYMENT_SHARE)}/min",
            ]
        lines = [
            f"ERROR {self.service} HTTP 500 POST /v1/payments: TimeoutError acquiring DB connection after 5000ms",
            f"WARN  db pool exhausted: {s['in_use']}/{self.pool_size} in use, "
            f"{self.PEAK_CONNECTIONS - s['in_use']} requests waiting",
            f"ERROR {s['failed_payments']} payments failed in the last minute",
            f"WARN  p95 latency {s['p95']}ms (SLO {MAX_P95_MS}ms)",
        ]
        for change in self.changes:
            lines.append(
                f"INFO  config {change['change_id']} by {change['author']}: "
                f"{change['key']} {change['old']} -> {change['new']}"
            )
        return lines

    def briefings(self, severity: str, team: str) -> dict:
        s = self._state()
        change = self.changes[-1] if self.changes else None
        change_text = (
            f"{change['change_id']} by {change['author']} set {change['key']} "
            f"{change['old']} -> {change['new']}, {change['minutes_ago']} min before alerts"
            if change else "no recent config change"
        )
        failing = 1 - s["success"]
        at_risk = s["failed_payments"] * self.AVG_ORDER_USD
        return {
            "engineering": (
                f"{s['in_use']}/{self.pool_size} DB connections in use, {s['timeouts']}/min connection "
                f"timeouts, p95 {s['p95']} ms, HTTP 500 rate {s['error_rate']:.1%}. Suspect: {change_text}."
            ),
            "support": (
                f"About {failing:.0%} of checkouts are failing ({s['failed_payments']}/min). Tell customers "
                "payments are degraded, a fix is being tested, and to retry shortly."
            ),
            "commander": (
                f"{severity} on {self.service}. Team: {team}. Timeline: {change_text}; alerts fired; "
                "AI diagnosis and repair auctions running. Your decision: approve a sandbox-tested repair."
            ),
            "leadership": (
                f"Payments are {failing:.0%} degraded: about {s['failed_payments']} failed checkouts per "
                f"minute, roughly ${at_risk:,}/min in revenue at risk (assumes ${self.AVG_ORDER_USD} per order)."
            ),
        }


class AmsterdamDatabaseOutage(Scenario):
    """The primary Postgres host in Amsterdam dies; Frankfurt holds a healthy replica."""

    scenario_id = "ams_db_outage"
    name = "Orders DB · Amsterdam primary down"
    service = "orders-api"
    region = "ams"
    source_system = "PagerDuty · Postgres HA monitor"
    alert = "pg-ams-1 primary health probe failing; EU order writes erroring"
    allowed_actions = ("restart_db", "failover_db", "route_traffic", "restart_service")
    decoy_plan = [action("restart_db", region="ams")]
    fix_plan = [action("failover_db", region="fra"), action("route_traffic", region="fra")]
    fake_diagnosis = (
        "Root cause: the Postgres primary pg-ams-1 in Amsterdam is down (host "
        "unreachable, 12/12 probes failed), so every EU order write fails. The "
        "Frankfurt replica pg-fra-2 is healthy with 2.0 s of replication lag, so "
        "failing over to fra and serving EU traffic from fra is safe."
    )

    REPLICAS = {"fra": 2.0}  # region -> replication lag in seconds
    MAX_LAG_S = 5.0
    EU_WRITES_PER_MIN = 4200
    LOCAL_P95_MS = 140
    CROSS_REGION_P95_MS = 420

    def _reset_state(self) -> None:
        self.primary = "ams"
        self.ams_host_up = True
        self.eu_traffic = "ams"
        self.lag_s = self.REPLICAS["fra"]

    def _break(self) -> None:
        self.ams_host_up = False

    def _primary_up(self) -> bool:
        return self.primary != "ams" or self.ams_host_up

    def _state(self) -> dict:
        up = self._primary_up()
        error_rate = 0.004 if up else 0.72
        p95 = self.LOCAL_P95_MS if self.eu_traffic == self.primary else self.CROSS_REGION_P95_MS
        if not up:
            p95 = 5000
        return {
            "up": up,
            "error_rate": error_rate,
            "p95": p95,
            "writes_failing": 0 if up else round(self.EU_WRITES_PER_MIN * error_rate),
        }

    def telemetry(self) -> list[dict]:
        s = self._state()
        return [
            metric("eu_error_rate", "EU error rate", s["error_rate"], "ratio", s["error_rate"] <= MAX_ERROR_RATE),
            metric("eu_p95_latency_ms", "EU p95 latency", s["p95"], "ms", s["p95"] <= MAX_P95_MS),
            metric("db_primary_reachable", "DB primary reachable", 1 if s["up"] else 0, "count", s["up"]),
            metric("db_writes_failing_per_min", "Failed writes", s["writes_failing"], "per_min",
                   s["writes_failing"] == 0),
            metric("replica_lag_s", "Replica lag (fra)", self.lag_s, "s", self.lag_s <= self.MAX_LAG_S),
        ]

    def health_checks(self) -> list[dict]:
        s = self._state()
        return [
            check("database primary reachable", s["up"], f"primary in {self.primary}"),
            check("EU error rate", s["error_rate"] <= MAX_ERROR_RATE,
                  f"{s['error_rate']:.1%} (limit {MAX_ERROR_RATE:.0%})"),
            check("EU p95 latency", s["p95"] <= MAX_P95_MS,
                  f"{s['p95']} ms with EU traffic in {self.eu_traffic} (limit {MAX_P95_MS} ms)"),
            check("replication lag within RPO", self.lag_s <= self.MAX_LAG_S,
                  f"{self.lag_s:.1f} s (limit {self.MAX_LAG_S:.0f} s)"),
        ]

    def _apply_step(self, step: dict) -> None:
        region = step["region"]
        if step["action"] == "failover_db":
            if region in self.REPLICAS:
                self._record_change("db.orders.primary", self.primary, region)
                self.primary = region
        elif step["action"] == "route_traffic":
            self._record_change("traffic.eu.region", self.eu_traffic, region)
            self.eu_traffic = region
        # restart_db cannot revive a dead host and restart_service does not touch
        # the database, so neither changes state.

    def logs(self) -> list[str]:
        s = self._state()
        if s["up"] and self.healthy():
            return [
                f"INFO  {self.service}({self.eu_traffic}) p95={s['p95']}ms errors={s['error_rate']:.1%}",
                f"INFO  postgres primary pg-{self.primary} accepting writes; replica lag {self.lag_s:.1f}s",
            ]
        return [
            f"ERROR {self.service}(ams) could not connect to postgres primary pg-ams-1:5432: connection refused",
            "ERROR pg-ams-1 health probe failed 12/12 (host unreachable since 06:58 UTC)",
            f"WARN  {s['writes_failing']} EU order writes failed in the last minute; EU traffic still routed to "
            f"{self.eu_traffic}",
            f"INFO  replica pg-fra-2 healthy, replication lag {self.lag_s:.1f}s, promotable",
        ]

    def briefings(self, severity: str, team: str) -> dict:
        s = self._state()
        return {
            "engineering": (
                f"pg-ams-1 (primary) is unreachable; {s['writes_failing']}/min EU writes failing, error rate "
                f"{s['error_rate']:.0%}. Replica pg-fra-2 is healthy with {self.lag_s:.1f} s lag (RPO 5 s)."
            ),
            "support": (
                "EU customers cannot place or update orders. Tell them orders are temporarily unavailable, "
                "no data has been lost, and service is being moved to a healthy region."
            ),
            "commander": (
                f"{severity} on {self.service} in Amsterdam. Team: {team}. The primary database host is down; "
                "a Frankfurt failover is being sandbox-tested. Your decision: approve the failover plan."
            ),
            "leadership": (
                f"EU ordering is down (about {s['writes_failing']} failed orders per minute). A tested "
                "failover to Frankfurt will restore it with at most a few seconds of replication lag."
            ),
        }


class AuthenticationAttack(Scenario):
    """A credential-stuffing attack floods the login endpoint."""

    scenario_id = "auth_attack"
    name = "Auth API · credential-stuffing attack"
    service = "auth-api"
    region = "iad"
    source_system = "Okta System Log + WAF"
    alert = "failed logins 160x baseline; suspicious source concentration"
    allowed_actions = ("apply_rate_limit", "block_ips", "restart_service", "restart_db")
    decoy_plan = [action("restart_service")]
    ATTACKERS = {"203.0.113.24": 0.34, "198.51.100.77": 0.28, "192.0.2.199": 0.18}
    fix_plan = [action("apply_rate_limit", value=20), action("block_ips", ips=list(ATTACKERS))]
    fake_diagnosis = (
        "Root cause: a credential-stuffing attack. Failed logins jumped from about "
        "300/min to 48,000/min; three sources (203.0.113.24, 198.51.100.77, "
        "192.0.2.199) carry 80% of them and the rest come from a rotating botnet. "
        "Real users see slow, failing logins. Nothing indicates a service or database fault."
    )

    ATTACK_PER_MIN = 48000
    BASELINE_FAILED = 300
    LEGIT_PER_MIN = 2400
    BOTNET_PER_IP_PER_MIN = 200
    LEGIT_PER_IP_PER_MIN = 5
    MAX_FAILED_PER_MIN = 2000

    def _reset_state(self) -> None:
        self.attacking = False
        self.rate_limit: int | None = None
        self.blocked: list[str] = []

    def _break(self) -> None:
        self.attacking = True

    def _state(self) -> dict:
        attack = 0.0
        if self.attacking:
            share = 1 - sum(self.ATTACKERS.get(ip, 0) for ip in self.blocked)
            limit_factor = 1.0 if self.rate_limit is None else min(1.0, self.rate_limit / self.BOTNET_PER_IP_PER_MIN)
            attack = self.ATTACK_PER_MIN * share * limit_factor
        pressure = min(1.0, attack / self.ATTACK_PER_MIN)
        success = 0.995 - 0.1 * pressure
        if self.rate_limit is not None and self.rate_limit < self.LEGIT_PER_IP_PER_MIN:
            success -= 0.3
        innocent = [ip for ip in self.blocked if ip not in self.ATTACKERS]
        return {
            "failed": round(attack + self.BASELINE_FAILED),
            "success": round(success, 4),
            "p95": round(180 + 900 * pressure),
            "open_sources": sum(ip not in self.blocked for ip in self.ATTACKERS) if self.attacking else 0,
            "innocent": innocent,
        }

    def telemetry(self) -> list[dict]:
        s = self._state()
        return [
            metric("failed_logins_per_min", "Failed logins", s["failed"], "per_min",
                   s["failed"] <= self.MAX_FAILED_PER_MIN),
            metric("login_success_rate", "Real-user login success", s["success"], "ratio", s["success"] >= MIN_SUCCESS),
            metric("p95_latency_ms", "Login p95 latency", s["p95"], "ms", s["p95"] <= MAX_P95_MS),
            metric("malicious_sources_open", "Malicious sources unblocked", s["open_sources"], "count",
                   s["open_sources"] == 0),
        ]

    def health_checks(self) -> list[dict]:
        s = self._state()
        return [
            check("failed logins", s["failed"] <= self.MAX_FAILED_PER_MIN,
                  f"{s['failed']:,}/min (limit {self.MAX_FAILED_PER_MIN:,}/min)"),
            check("real-user login success", s["success"] >= MIN_SUCCESS,
                  f"{s['success']:.1%} (min {MIN_SUCCESS:.0%})"),
            check("login p95 latency", s["p95"] <= MAX_P95_MS, f"{s['p95']} ms (limit {MAX_P95_MS} ms)"),
            check("no legitimate sources blocked", not s["innocent"],
                  ", ".join(s["innocent"]) if s["innocent"] else "blocklist matches attack sources"),
        ]

    def _apply_step(self, step: dict) -> None:
        if step["action"] == "apply_rate_limit":
            self._record_change("auth.login.rate_limit_per_ip", str(self.rate_limit), str(step["value"]))
            self.rate_limit = step["value"]
        elif step["action"] == "block_ips":
            new = [ip for ip in step["ips"] if ip not in self.blocked]
            self._record_change("waf.blocklist", str(len(self.blocked)), str(len(self.blocked) + len(new)))
            self.blocked += new
        # Restarts do nothing against an external attack.

    def logs(self) -> list[str]:
        s = self._state()
        if not self.attacking or self.healthy():
            return [
                f"INFO  {self.service} logins ok: success={s['success']:.1%} p95={s['p95']}ms",
                f"INFO  failed logins {s['failed']:,}/min",
            ]
        lines = [
            f"WARN  {self.service} failed logins {s['failed']:,}/min (baseline {self.BASELINE_FAILED}/min)",
        ]
        for ip, share in self.ATTACKERS.items():
            if ip not in self.blocked:
                lines.append(f"WARN  credential stuffing from {ip}: {round(self.ATTACK_PER_MIN * share):,}/min, "
                             "98% invalid passwords")
        lines += [
            "INFO  remaining failures spread across ~1,900 rotating IPs (~200 attempts/min each)",
            f"WARN  real-user login success {s['success']:.1%}, p95 {s['p95']}ms",
        ]
        return lines

    def briefings(self, severity: str, team: str) -> dict:
        s = self._state()
        return {
            "engineering": (
                f"Credential stuffing: {s['failed']:,} failed logins/min. Three sources carry 80% of the attack; "
                "the rest is a rotating botnet at ~200 attempts/min per IP. Real-user success "
                f"{s['success']:.1%}, p95 {s['p95']} ms."
            ),
            "support": (
                "Some customers see slow or failed logins. Tell them there is no evidence of account "
                "compromise yet, and recommend a password reset if they reused their password elsewhere."
            ),
            "commander": (
                f"{severity} security incident on {self.service}. Team: {team}. A rate limit plus blocklist "
                "is being sandbox-tested. Your decision: approve the security controls."
            ),
            "leadership": (
                f"An automated login attack is degrading sign-in for real users ({1 - s['success']:.0%} failing). "
                "No confirmed data breach; protective controls are being deployed."
            ),
        }


class RegionalNetworkPartition(Scenario):
    """A transit partition cuts APAC users off from a healthy Frankfurt origin."""

    scenario_id = "network_partition"
    name = "Checkout · APAC network partition"
    service = "checkout-api"
    region = "fra"
    source_system = "Cloudflare + ThousandEyes"
    alert = "checkout unreachable from sin PoP; origin health checks green"
    allowed_actions = ("route_traffic", "restart_service", "restart_db", "failover_db")
    decoy_plan = [action("restart_service")]
    fix_plan = [action("route_traffic", region="iad")]
    fake_diagnosis = (
        "Root cause: a network partition between the Singapore edge and the "
        "Frankfurt origin after transit change net-118. The origin is healthy "
        "locally (100% health checks) but 96% of APAC requests time out. Routing "
        "APAC traffic to the healthy iad origin restores reachability."
    )

    ORIGINS = {"fra", "iad"}
    PARTITIONED = {"fra", "ams"}  # destinations sin cannot reach during the partition
    APAC_P95_MS = {"fra": 210, "iad": 240, "ams": 220}
    APAC_SHARE = 0.3

    def _reset_state(self) -> None:
        self.apac_route = "fra"
        self.partitioned = False
        self.restarts = 0

    def _break(self) -> None:
        self.partitioned = True
        self.changes.append({
            "change_id": "net-118",
            "key": "transit.sin.primary",
            "old": "telia",
            "new": "cogent",
            "author": "netops-bot",
            "minutes_ago": 11,
        })

    def _state(self) -> dict:
        has_origin = self.apac_route in self.ORIGINS
        cut = self.partitioned and self.apac_route in self.PARTITIONED
        reachability = 0.04 if cut else (0.999 if has_origin else 0.0)
        p95 = self.APAC_P95_MS.get(self.apac_route, 0) if reachability > 0.5 else 10000
        return {
            "reachability": reachability,
            "p95": p95,
            "error_rate": round(self.APAC_SHARE * (1 - reachability), 4),
        }

    def telemetry(self) -> list[dict]:
        s = self._state()
        return [
            metric("apac_reachability", "APAC reachability", s["reachability"], "ratio",
                   s["reachability"] >= MIN_SUCCESS),
            metric("apac_p95_latency_ms", "APAC p95 latency", s["p95"], "ms", s["p95"] <= MAX_P95_MS),
            metric("global_error_rate", "Global error rate", s["error_rate"], "ratio",
                   s["error_rate"] <= MAX_ERROR_RATE),
            metric("origin_health", "Origin health (fra)", 1.0, "ratio", True),
        ]

    def health_checks(self) -> list[dict]:
        s = self._state()
        return [
            check("APAC reachability", s["reachability"] >= MIN_SUCCESS,
                  f"{s['reachability']:.1%} via {self.apac_route} (min {MIN_SUCCESS:.0%})"),
            check("APAC p95 latency", s["p95"] <= MAX_P95_MS, f"{s['p95']} ms (limit {MAX_P95_MS} ms)"),
            check("global error rate", s["error_rate"] <= MAX_ERROR_RATE,
                  f"{s['error_rate']:.1%} (limit {MAX_ERROR_RATE:.0%})"),
            check("origin healthy", True, "fra origin 100% healthy locally"),
        ]

    def _apply_step(self, step: dict) -> None:
        if step["action"] == "route_traffic":
            self._record_change("traffic.apac.region", self.apac_route, step["region"])
            self.apac_route = step["region"]
        elif step["action"] == "restart_service":
            self.restarts += 1
        # Database actions cannot fix a network path, so they change nothing.

    def logs(self) -> list[str]:
        s = self._state()
        if self.healthy():
            return [
                f"INFO  {self.service} APAC via {self.apac_route}: reachability {s['reachability']:.1%}, "
                f"p95 {s['p95']}ms",
                "INFO  origin fra health checks 100% green",
            ]
        lines = [
            f"ERROR edge sin -> origin {self.apac_route}: 96% of requests timed out (connect timeout 10s)",
            "INFO  origin fra health checks 100% green from fra and iad probes",
            f"WARN  ThousandEyes: packet loss 96% on sin -> {self.apac_route} path via cogent",
            f"WARN  global error rate {s['error_rate']:.1%}, all from APAC users",
        ]
        for change in self.changes:
            lines.append(f"INFO  change {change['change_id']} by {change['author']}: "
                         f"{change['key']} {change['old']} -> {change['new']}")
        return lines

    def briefings(self, severity: str, team: str) -> dict:
        s = self._state()
        return {
            "engineering": (
                f"APAC users can't reach checkout: reachability {s['reachability']:.0%} via {self.apac_route}, "
                "packet loss 96% on the sin -> fra transit path since net-118. The origin itself is healthy."
            ),
            "support": (
                "Customers in Asia-Pacific cannot complete checkout. Tell them it is a regional network "
                "problem, their carts are saved, and traffic is being rerouted."
            ),
            "commander": (
                f"{severity} on {self.service}: regional network partition. Team: {team}. A reroute to a "
                "healthy region is being sandbox-tested. Your decision: approve the traffic change."
            ),
            "leadership": (
                f"Checkout is unavailable for APAC customers ({s['error_rate']:.0%} of global traffic failing). "
                "The platform is healthy; a network reroute will restore access."
            ),
        }


SCENARIO_TYPES: list[type[Scenario]] = [
    PaymentsPoolExhaustion,
    AmsterdamDatabaseOutage,
    AuthenticationAttack,
    RegionalNetworkPartition,
]
SCENARIOS: dict[str, type[Scenario]] = {cls.scenario_id: cls for cls in SCENARIO_TYPES}
SCENARIO_IDS: list[str] = list(SCENARIOS)
DEFAULT_SCENARIO = "payments_pool"


def create(scenario_id: str) -> Scenario:
    return SCENARIOS[scenario_id]()


def catalog() -> list[dict]:
    return [cls().catalog() for cls in SCENARIO_TYPES]
