CREATE TABLE team_members (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_owner INTEGER NOT NULL DEFAULT 0 CHECK (is_owner IN (0, 1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (business_id, id)
);

ALTER TABLE availability_rules ADD COLUMN team_member_id TEXT REFERENCES team_members(id);
ALTER TABLE availability_exceptions ADD COLUMN team_member_id TEXT REFERENCES team_members(id);
ALTER TABLE appointments ADD COLUMN team_member_id TEXT REFERENCES team_members(id);

INSERT INTO team_members (id, business_id, name, is_owner, active, created_at, updated_at)
SELECT 'owner-' || u.id, u.business_id, u.display_name, 1, 1, u.created_at, u.created_at
FROM users u;

UPDATE availability_rules
SET team_member_id = (SELECT tm.id FROM team_members tm WHERE tm.business_id = availability_rules.business_id AND tm.is_owner = 1 LIMIT 1)
WHERE team_member_id IS NULL;

UPDATE availability_exceptions
SET team_member_id = (SELECT tm.id FROM team_members tm WHERE tm.business_id = availability_exceptions.business_id AND tm.is_owner = 1 LIMIT 1)
WHERE team_member_id IS NULL;

UPDATE appointments
SET team_member_id = (SELECT tm.id FROM team_members tm WHERE tm.business_id = appointments.business_id AND tm.is_owner = 1 LIMIT 1)
WHERE team_member_id IS NULL;

CREATE INDEX idx_team_members_business ON team_members(business_id, active, name);
CREATE INDEX idx_availability_rules_team ON availability_rules(business_id, team_member_id, weekday, active);
CREATE INDEX idx_appointments_team_start ON appointments(business_id, team_member_id, starts_at);
