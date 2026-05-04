/**
 * Optional Slack Incoming Webhook notification for the monthly job.
 * Set SLACK_WEBHOOK_URL in the environment. Errors are logged only; they do not fail the job.
 */

/**
 * @param {object} params
 * @param {string} params.reportPeriod - e.g. "2026-04"
 * @param {number} params.rowsInserted - rows successfully inserted into BigQuery
 * @param {number} [params.expectedRows] - e.g. studio count when a "full success" 🟢 is appropriate
 */
export async function notifySlackMonthlyInsert({ reportPeriod, rowsInserted, expectedRows }) {
  const url = process.env.SLACK_WEBHOOK_URL?.trim();
  if (!url) return;

  let prefix = "";
  if (rowsInserted === 0) {
    prefix = "🚨 ";
  } else if (expectedRows != null && rowsInserted === expectedRows) {
    prefix = "🟢 ";
  }

  const text = `${prefix}ClassPass monthly sync (${reportPeriod}): BigQuery inserted ${rowsInserted} row(s).`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn("Slack notify failed:", res.status, body);
    }
  } catch (err) {
    console.warn("Slack notify error:", err?.message || err);
  }
}
