-- Additive: older releases never read or write it.
ALTER TABLE "cloud_agents" ADD COLUMN "summary" TEXT;
