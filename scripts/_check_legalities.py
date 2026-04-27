import duckdb, urllib.request, json
# Use HTTP because the DB file is locked by the running uvicorn.
# Query via a custom endpoint... no such endpoint, so write a small one-shot
# DuckDB query through a duplicate read connection (DuckDB allows multiple
# read-only handles). Actually duckdb single-process exclusive; let's just
# print legalities via the printings endpoint.
# Just hit the /api/printings endpoint to inspect.
import urllib.request, json
def post(path, body):
    req = urllib.request.Request(f'http://127.0.0.1:30303{path}',
        data=json.dumps(body).encode(),
        headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())

r = post('/api/printings', {'name': 'Black Lotus', 'limit': 3})
print('Black Lotus printings (first 3):')
for p in r['printings'][:3]:
    print(f"  set={p.get('set')} legal_standard={p.get('legal_standard')} "
          f"legal_legacy={p.get('legal_legacy')} legal_modern={p.get('legal_modern')} "
          f"legal_commander={p.get('legal_commander')}")
print()
r = post('/api/printings', {'name': 'Lightning Bolt', 'limit': 3})
print('Lightning Bolt printings (first 3):')
for p in r['printings'][:3]:
    print(f"  set={p.get('set')} legal_standard={p.get('legal_standard')} "
          f"legal_pauper={p.get('legal_pauper')} legal_modern={p.get('legal_modern')}")
