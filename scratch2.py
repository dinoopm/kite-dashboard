import urllib.request
import csv
url = "https://api.kite.trade/instruments"
req = urllib.request.Request(url)
with urllib.request.urlopen(req) as response:
    lines = [line.decode('utf-8') for line in response.readlines()]

reader = csv.DictReader(lines)
for row in reader:
    if row['tradingsymbol'] in ['NIFTY CHEMICALS', 'NIFTY COMMODITIES']:
        print(f"{row['tradingsymbol']}: TOKEN {row['instrument_token']}")
