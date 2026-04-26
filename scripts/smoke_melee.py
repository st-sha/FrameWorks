import json, urllib.request
body = json.dumps({
    'decklist': {'url': 'https://melee.gg/Decklist/View/c5b52d47-45b4-43bb-bbe0-2b8f6343ad66'},
    'aesthetic_ids': ['frame_future', 'showcase', 'borderless', 'frame_1997', 'frame_2015'],
    'include_sideboard': True,
    'include_basics': False,
}).encode()
req = urllib.request.Request('http://127.0.0.1:8080/api/analyze', data=body, headers={'content-type': 'application/json'})
r = json.loads(urllib.request.urlopen(req, timeout=60).read())
print('totals:', r['totals'])
print('warnings:', r['warnings'][:5])
for s in r['summary']:
    print(f"  {s['label']:25s}  {s['available_unique']:>2}/{s['total_unique']}  {s['coverage_pct']:>5.1f}%")
