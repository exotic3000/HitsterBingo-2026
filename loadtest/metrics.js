/* Sammelt Messwerte (Latenzen in ms, Zähler) und fasst sie als
   Perzentile zusammen; dazu ein Sampler für CPU und Speicher des
   Serverprozesses (liest /proc, also nur unter Linux). */

const fs = require('fs');

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function round(v) { return v === null || v === undefined ? null : Math.round(v * 10) / 10; }

function createRecorder() {
  const series = new Map();
  const counters = new Map();
  return {
    add(name, value) {
      if (!series.has(name)) series.set(name, []);
      series.get(name).push(value);
    },
    inc(name, n = 1) { counters.set(name, (counters.get(name) || 0) + n); },
    count(name) { return counters.get(name) || 0; },
    summary() {
      const out = { series: {}, counters: Object.fromEntries(counters) };
      for (const [name, values] of series) {
        const sorted = [...values].sort((a, b) => a - b);
        out.series[name] = {
          n: sorted.length,
          p50: round(percentile(sorted, 50)),
          p95: round(percentile(sorted, 95)),
          p99: round(percentile(sorted, 99)),
          max: round(sorted[sorted.length - 1]),
        };
      }
      return out;
    },
  };
}

const CLOCK_TICKS = 100; // USER_HZ, on Linux practically always 100
const PAGE_SIZE = 4096;

function readProc(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const cpuTicks = Number(fields[11]) + Number(fields[12]); // utime + stime
    const rssPages = Number(fs.readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ')[1]);
    return { cpuTicks, rssMb: (rssPages * PAGE_SIZE) / 1024 / 1024 };
  } catch (e) {
    return null; // process gone (e.g. during the crash test) or not Linux
  }
}

// Samples the server process once per second: CPU in % of one core, RSS in MB.
function createProcessSampler(getPid, recorder) {
  let last = null;
  const timer = setInterval(() => {
    const pid = getPid();
    const now = Date.now();
    const cur = pid && readProc(pid);
    if (!cur) { last = null; return; }
    if (last && last.pid === pid) {
      const cpuPct = ((cur.cpuTicks - last.cpuTicks) / CLOCK_TICKS) / ((now - last.at) / 1000) * 100;
      recorder.add('server_cpu_pct', cpuPct);
    }
    recorder.add('server_rss_mb', cur.rssMb);
    last = { ...cur, pid, at: now };
  }, 1000);
  return { stop: () => clearInterval(timer) };
}

module.exports = { createRecorder, createProcessSampler };
