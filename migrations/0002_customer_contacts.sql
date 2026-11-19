ALTER TABLE customers ADD COLUMN phone_match_key TEXT NOT NULL DEFAULT '';
ALTER TABLE customers ADD COLUMN deleted_at TEXT;

UPDATE customers
SET phone_match_key = phone_normalized
WHERE phone_normalized NOT LIKE 'no-phone-%';

CREATE INDEX idx_customers_business_phone_match
ON customers (business_id, phone_match_key);
