#!/bin/bash

curl -L "https://zenodo.org/records/4148888/files/BKR-R-fullKGdump.ttl.gz?download=1" | gunzip > BKR-R-fullKGdump.ttl
curl -L "https://zenodo.org/records/4148888/files/BKR-S-fullKGdump.ttl.gz?download=1" | gunzip > BKR-S-fullKGdump.ttl
