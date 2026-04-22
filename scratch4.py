import urllib.request, csv
req = urllib.request.Request("https://api.kite.trade/instruments")
with urllib.request.urlopen(req) as res:
    lines = [line.decode('utf-8') for line in res.readlines()]
for r in csv.DictReader(lines):
    if r['tradingsymbol'] == 'NIFTY CHEMICALS':
        print(r['exchange'], r['segment'])
