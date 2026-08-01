-- The e2e suite truncates every table, so it must never point at the dev database.
CREATE DATABASE cbd_test OWNER cbd;
