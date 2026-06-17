import sys, os, sqlite3
p = os.path.expanduser("~/.wizstar/wizstar.db")
c = sqlite3.connect(p)
c.row_factory = sqlite3.Row
rows = c.execute(
    "SELECT id, email, length(bearer) as bl, length(cs_session) as cl, status, created_at "
    "FROM qf_accounts ORDER BY created_at DESC"
).fetchall()
print("qf_accounts count:", len(rows))
for r in rows[:10]:
    print(f"  id={r['id']} email={r['email']} bearer_len={r['bl']} cs_len={r['cl']} status={r['status']}")
c.close()
