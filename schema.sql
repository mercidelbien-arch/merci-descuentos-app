-- Tipos de campaña
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'campaign_type') THEN
    CREATE TYPE campaign_type AS ENUM ('percentage', 'absolute');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'campaign_status') THEN
    CREATE TYPE campaign_status AS ENUM ('active', 'paused', 'deleted');
  END IF;
END $$;

-- Tabla de campañas
CREATE TABLE IF NOT EXISTS campaigns (
  id BIGSERIAL PRIMARY KEY,
  store_id TEXT NOT NULL,
  code TEXT NOT NULL,
  type campaign_type NOT NULL,
  value NUMERIC(12,2) NOT NULL CHECK (value >= 0),
  max_discount NUMERIC(12,2),
  min_subtotal NUMERIC(12,2) DEFAULT 0 CHECK (min_subtotal >= 0),
  include_categories INT[],
  exclude_categories INT[],
  include_products INT[],
  exclude_products INT[],
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  usage_limit_total INT,
  usage_limit_per_customer INT,
  used_count_total INT DEFAULT 0,
  status campaign_status NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_campaigns_store_code
  ON campaigns(store_id, code) WHERE status <> 'deleted';

-- Tabla de redenciones (historial de uso de cupones)
CREATE TABLE IF NOT EXISTS redemptions (
  id BIGSERIAL PRIMARY KEY,
  campaign_id BIGINT REFERENCES campaigns(id) ON DELETE CASCADE,
  order_id TEXT,
  customer_id TEXT,
  amount_discounted NUMERIC(12,2) NOT NULL,
  used_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Trigger para updated_at
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_set_updated_at ON campaigns;
CREATE TRIGGER trg_set_updated_at
BEFORE UPDATE ON campaigns
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
