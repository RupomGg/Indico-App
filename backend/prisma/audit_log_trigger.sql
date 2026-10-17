-- Trigger function ensuring AuditLog is strictly append-only (PRD Requirement)
CREATE OR REPLACE FUNCTION prevent_audit_log_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'AuditLog is append-only: updates and deletes are strictly prohibited.';
END;
$$ LANGUAGE plpgsql;

-- Apply trigger before update
DROP TRIGGER IF EXISTS audit_log_prevent_update ON audit_logs;
CREATE TRIGGER audit_log_prevent_update
BEFORE UPDATE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_modification();

-- Apply trigger before delete
DROP TRIGGER IF EXISTS audit_log_prevent_delete ON audit_logs;
CREATE TRIGGER audit_log_prevent_delete
BEFORE DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_modification();
