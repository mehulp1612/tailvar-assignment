PRAGMA foreign_keys = ON;
CREATE TABLE users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  salt TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('Customer','Administrator'))
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE policies (
  id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES users(id), start_date TEXT NOT NULL,
  end_date TEXT NOT NULL CHECK(end_date >= start_date),
  sum_insured INTEGER NOT NULL CHECK(typeof(sum_insured) = 'integer' AND sum_insured > 0 AND sum_insured <= 999999999999),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX policies_customer ON policies(customer_id);
CREATE TABLE claims (
  id TEXT PRIMARY KEY, policy_id TEXT NOT NULL REFERENCES policies(id), incident_date TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK(typeof(amount) = 'integer' AND amount > 0 AND amount <= 999999999999),
  status TEXT NOT NULL DEFAULT 'Submitted' CHECK(status IN ('Submitted','Approved','Rejected')),
  request_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at TEXT, decided_by TEXT REFERENCES users(id)
);
CREATE INDEX claims_policy_status ON claims(policy_id,status);
CREATE TRIGGER policy_customer BEFORE INSERT ON policies BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM users WHERE id = NEW.customer_id AND role = 'Customer') THEN RAISE(ABORT, 'INVALID_CUSTOMER') END;
END;
CREATE TRIGGER claim_integrity BEFORE INSERT ON claims BEGIN
  SELECT CASE WHEN NEW.status != 'Submitted' THEN RAISE(ABORT, 'INVALID_STATUS') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM policies WHERE id = NEW.policy_id AND NEW.incident_date BETWEEN start_date AND end_date) THEN RAISE(ABORT, 'INVALID_COVERAGE') END;
  SELECT CASE WHEN NEW.amount + COALESCE((SELECT SUM(amount) FROM claims WHERE policy_id = NEW.policy_id AND status IN ('Submitted','Approved')),0) > (SELECT sum_insured FROM policies WHERE id = NEW.policy_id) THEN RAISE(ABORT, 'INSUFFICIENT_SI') END;
END;
CREATE TRIGGER claim_decision BEFORE UPDATE ON claims BEGIN
  SELECT CASE WHEN OLD.status != 'Submitted' OR NEW.status NOT IN ('Approved','Rejected') THEN RAISE(ABORT, 'INVALID_DECISION') END;
  SELECT CASE WHEN NEW.id != OLD.id OR NEW.policy_id != OLD.policy_id OR NEW.amount != OLD.amount OR NEW.incident_date != OLD.incident_date OR NEW.request_id != OLD.request_id THEN RAISE(ABORT, 'IMMUTABLE_CLAIM') END;
  SELECT CASE WHEN NEW.decided_at IS NULL OR NOT EXISTS(SELECT 1 FROM users WHERE id = NEW.decided_by AND role = 'Administrator') THEN RAISE(ABORT, 'INVALID_DECIDER') END;
END;
CREATE TRIGGER policy_immutable BEFORE UPDATE ON policies BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_POLICY'); END;
INSERT INTO users(id,username,password_hash,salt,role) VALUES
('customer1','customer1','2210edd0d3723435e1d78210d97ea84c0484637418c6339d3019445484ca0215','tailvar-demo-customer1','Customer'),
('customer2','customer2','ec3129c95f29d5f4394760b83bf75e653a3350e9c2cb49cbf56d78b71c9f78e7','tailvar-demo-customer2','Customer'),
('admin','admin','0c3282b0dd061cb531f243f456e9f3610209103652433804fb6a4a5f6c09f8e8','tailvar-demo-admin','Administrator');
