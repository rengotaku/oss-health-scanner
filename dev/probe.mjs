const token = process.argv[2];
const h = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "oss-health-scanner/0.1 (+https://github.com)" };
for (const p of ["stats/commit_activity", "stats/contributors"]) {
  for (let i = 0; i < 4; i++) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 6000);
    try {
      const r = await fetch(`https://api.github.com/repos/curl/curl/${p}`, { headers: h, signal: c.signal });
      let n = 0;
      if (r.body) { const rd = r.body.getReader(); for(;;){ const {done,value}=await rd.read(); if(done)break; n+=value.byteLength; if(n>4*1024*1024){await rd.cancel();break;} } }
      console.log(`${p} try${i}: status=${r.status} bytesRead=${n}`);
      if (r.status === 200) break;
    } catch (e) {
      console.log(`${p} try${i}: threw ${e.name}`);
    } finally { clearTimeout(t); }
    await new Promise(r => setTimeout(r, 1000));
  }
}
