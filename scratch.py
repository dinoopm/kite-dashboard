import urllib.request
import csv
url = "https://api.kite.trade/instruments"
req = urllib.request.Request(url)
with urllib.request.urlopen(req) as response:
    lines = [line.decode('utf-8') for line in response.readlines()]

reader = csv.DictReader(lines)
for row in reader:
    if 'CHEM' in row['tradingsymbol'].upper() or 'CHEM' in row['name'].upper():
        if row['instrument_type'] == 'EQ':
            # print(row['tradingsymbol'])
            pass
    if row['segment'] == 'INDICES':
        if 'CHEM' in row['tradingsymbol'].upper():
            print("INDEX MATCH:", row['tradingsymbol'])
