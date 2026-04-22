import urllib.request, json
url = "http://localhost:3001/api/quotes"
data = json.dumps({"instruments": ["NSE:NIFTY CHEMICALS", "NSE:NIFTY 50"]}).encode()
req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'})
with urllib.request.urlopen(req) as res:
    print(res.read().decode())
