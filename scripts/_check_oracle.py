import duckdb
c = duckdb.connect('data/deckaesthetics.duckdb', read_only=True)
cols = [r[0] for r in c.execute("SELECT column_name FROM information_schema.columns WHERE table_name='cards'").fetchall()]
print('cards columns:', cols)
if 'type_line' in cols:
    print('rows w/ type_line populated:', c.execute('SELECT COUNT(*) FROM cards WHERE type_line IS NOT NULL').fetchone()[0])
    print('rows w/ colors populated:', c.execute('SELECT COUNT(*) FROM cards WHERE colors IS NOT NULL').fetchone()[0])
print('total cards:', c.execute('SELECT COUNT(*) FROM cards').fetchone()[0])
