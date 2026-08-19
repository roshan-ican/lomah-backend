FROM node:22-bookworm-slim

WORKDIR /simulator
COPY docker/simulator/target-simulator.mjs ./target-simulator.mjs

USER node
CMD ["node", "target-simulator.mjs"]
