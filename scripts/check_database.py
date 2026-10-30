"""Offline verification of the shipped schema and API's atomic SQL using SQLite.

This supplements, and does not replace, the Miniflare API integration suite.
"""
import concurrent.futures
import hashlib
import pathlib
import re
import sqlite3
import unittest
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[1]
API = (ROOT / 'server/index.ts').read_text(encoding='utf-8')
INSERT = re.search(r'`(INSERT INTO claims[^`]+)`', API).group(1)
DECIDE = re.search(r'"(UPDATE claims SET status=[^"]+)"', API).group(1)


class DatabaseRules(unittest.TestCase):
    def setUp(self):
        directory = ROOT / '.verification'
        directory.mkdir(exist_ok=True)
        self.path = directory / f'{uuid.uuid4()}.sqlite'
        db = self.connection()
        with db:
            db.executescript((ROOT / 'migrations/0001_initial.sql').read_text())
            db.execute("INSERT INTO policies(id,customer_id,start_date,end_date,sum_insured) VALUES ('p','customer1','2026-01-01','2026-12-31',10000)")
        db.close()

    def tearDown(self):
        self.path.unlink()

    def connection(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.execute('PRAGMA foreign_keys=ON')
        return db

    def submit(self, amount=6000, date='2026-01-01', owner='customer1', request=None):
        identifier = str(uuid.uuid4())
        request = request or str(uuid.uuid4())
        db = self.connection()
        try:
            with db:
                changed = db.execute(INSERT, (identifier,date,amount,request,'p',owner,date,amount,request)).rowcount
            return identifier if changed else None
        finally:
            db.close()

    def decide(self, identifier, status):
        db = self.connection()
        try:
            with db:
                return db.execute(DECIDE,(status,'admin',identifier)).fetchone()
        finally:
            db.close()

    def remaining(self):
        db = self.connection()
        try:
            return db.execute("SELECT 10000-COALESCE(SUM(amount),0) FROM claims WHERE status IN ('Submitted','Approved')").fetchone()[0]
        finally:
            db.close()

    def test_accounting_and_final_decisions(self):
        first = self.submit()
        self.assertEqual(self.remaining(),4000)
        self.assertIsNone(self.submit(5000))
        self.assertIsNotNone(self.decide(first,'Rejected'))
        self.assertEqual(self.remaining(),10000)
        second = self.submit(10000)
        self.assertIsNotNone(self.decide(second,'Approved'))
        self.assertEqual(self.remaining(),0)
        self.assertIsNone(self.decide(second,'Rejected'))

    def test_concurrent_submissions(self):
        with concurrent.futures.ThreadPoolExecutor(8) as pool:
            results = list(pool.map(lambda _: self.submit(), range(8)))
        self.assertEqual(sum(result is not None for result in results),1)
        self.assertEqual(self.remaining(),4000)

    def test_concurrent_decisions(self):
        identifier = self.submit()
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            results = list(pool.map(lambda status: self.decide(identifier,status),['Approved','Rejected']))
        self.assertEqual(sum(result is not None for result in results),1)
        self.assertIn(self.remaining(),[4000,10000])

    def test_duplicate_delivery(self):
        request = str(uuid.uuid4())
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            results = list(pool.map(lambda _: self.submit(request=request),range(2)))
        self.assertEqual(sum(result is not None for result in results),1)
        self.assertEqual(self.remaining(),4000)

    def test_ownership_and_coverage(self):
        self.assertIsNone(self.submit(owner='customer2'))
        self.assertIsNone(self.submit(date='2025-12-31'))
        self.assertIsNone(self.submit(date='2027-01-01'))
        self.assertIsNotNone(self.submit(100,date='2026-01-01'))
        self.assertIsNotNone(self.submit(100,date='2026-12-31'))

    def test_database_rejects_bypassed_invalid_writes(self):
        db = self.connection()
        try:
            for amount,date in [(10001,'2026-01-01'),(0,'2026-01-01'),(-1,'2026-01-01'),(1.5,'2026-01-01'),(100,'2027-01-01')]:
                with self.assertRaises(sqlite3.IntegrityError):
                    db.execute('INSERT INTO claims(id,policy_id,incident_date,amount,request_id) VALUES (?,?,?,?,?)',(str(uuid.uuid4()),'p',date,amount,str(uuid.uuid4())))
        finally:
            db.close()

    def test_demo_passwords(self):
        db = self.connection()
        try:
            for username,password in [('customer1','Customer1@Demo26'),('customer2','Customer2@Demo26'),('admin','Admin@Demo26')]:
                salt,expected = db.execute('SELECT salt,password_hash FROM users WHERE username=?',(username,)).fetchone()
                self.assertEqual(hashlib.pbkdf2_hmac('sha256',password.encode(),salt.encode(),100000).hex(),expected)
        finally:
            db.close()

    def test_persistence_across_connections(self):
        self.submit()
        self.assertEqual(self.remaining(),4000)


if __name__ == '__main__':
    unittest.main(verbosity=2)
