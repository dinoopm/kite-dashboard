import urllib.request, json
url = "http://localhost:3001/api/alerts"
req = urllib.request.Request(url)
with urllib.request.urlopen(req) as res:
    data = json.loads(res.read().decode())
    for d in data:
        if d['symbol'] == 'VEDL':
            print(json.dumps(d, indent=2))
