import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, describe } from "node:test";

/**
 * The committed Grafana dashboard.
 *
 * Grafana is not available in the test environment, so the import itself stays
 * a described manual check in the PR. What is checked here is the part an
 * import rejects: malformed JSON, a missing data source input, a panel with no
 * query, duplicate ids and a panel outside the 24-column grid. The test also
 * pins the metric families the dashboard promises to chart, so renaming one in
 * `src/lib/metrics.ts` cannot silently empty a panel.
 */

interface Target {
  expr: string;
  refId: string;
}

interface Panel {
  id: number;
  type: string;
  title?: string;
  gridPos: { h: number; w: number; x: number; y: number };
  datasource?: { type: string; uid: string };
  targets?: Target[];
}

interface Dashboard {
  title: string;
  uid: string;
  schemaVersion: number;
  tags: string[];
  panels: Panel[];
  __inputs?: Array<{ name: string; type: string; pluginId: string }>;
  templating: { list: Array<{ name: string; type: string }> };
}

const dashboard = JSON.parse(
  readFileSync(new URL("../deploy/grafana/payflow.json", import.meta.url), "utf8"),
) as Dashboard;

const panels = dashboard.panels.filter((panel) => panel.type !== "row");
const expressions = panels.flatMap((panel) => (panel.targets ?? []).map((target) => target.expr));

describe("deploy/grafana/payflow.json", () => {
  test("is a Grafana 11 dashboard that asks for a Prometheus data source on import", () => {
    assert.equal(dashboard.title, "Payflow Backend");
    assert.equal(dashboard.uid, "payflow-backend");
    assert.equal(dashboard.schemaVersion, 39);
    assert.ok(dashboard.tags.includes("payflow"));

    const input = dashboard.__inputs?.find((entry) => entry.name === "DS_PROMETHEUS");
    assert.ok(input, "the import prompt is declared in __inputs");
    assert.equal(input.type, "datasource");
    assert.equal(input.pluginId, "prometheus");

    const variables = dashboard.templating.list.map((variable) => variable.name);
    assert.ok(variables.includes("DS_PROMETHEUS"));
    assert.ok(variables.includes("network"), "the network filter is a template variable");
  });

  test("every panel is placed, identified and queried", () => {
    assert.ok(panels.length > 0);

    const ids = new Set<number>();
    for (const panel of dashboard.panels) {
      assert.equal(ids.has(panel.id), false, `panel id ${panel.id} is unique`);
      ids.add(panel.id);
      assert.ok(panel.gridPos.x >= 0 && panel.gridPos.x + panel.gridPos.w <= 24, `${panel.title} fits the grid`);
      assert.ok(panel.gridPos.w > 0 && panel.gridPos.h > 0, `${panel.title} has a size`);
    }

    for (const panel of panels) {
      assert.ok(panel.targets && panel.targets.length > 0, `${panel.title} has a query`);
      assert.equal(panel.datasource?.uid, "${DS_PROMETHEUS}", `${panel.title} uses the import data source`);
      for (const target of panel.targets) {
        assert.ok(target.expr.trim().length > 0, `${panel.title} has a non-empty expression`);
        assert.ok(target.refId.length > 0, `${panel.title} names its query`);
        assert.ok(target.expr.includes("$network"), `${panel.title} honours the network filter`);
      }
    }
  });

  test("covers lag, keeper results, webhook deliveries, request latency and business gauges", () => {
    const required = [
      // Lag and indexer progress.
      "payflow_indexer_lag",
      "payflow_indexer_cursor",
      "payflow_indexer_latest_ledger",
      "payflow_events_applied_total",
      // Keeper results.
      "payflow_keeper_passes_total",
      "payflow_charges_settled_total",
      "payflow_charges_failed_total",
      // Webhook deliveries.
      "payflow_webhook_deliveries_total",
      // Request latency.
      "histogram_quantile",
      "payflow_http_request_duration_seconds_bucket",
      // Business gauges.
      "payflow_active_mandates",
      "payflow_active_merchants",
      "payflow_mrr",
    ];
    for (const metric of required) {
      assert.ok(
        expressions.some((expr) => expr.includes(metric)),
        `the dashboard charts ${metric}`,
      );
    }
  });
});
