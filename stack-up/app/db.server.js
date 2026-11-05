import { PrismaClient } from "@prisma/client";

function createPrismaClient() {
  return new PrismaClient();
}

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal || !global.prismaGlobal.offer) {
    if (global.prismaGlobal) {
      try {
        global.prismaGlobal.$disconnect().catch(() => {});
      } catch {}
    }
    global.prismaGlobal = createPrismaClient();
  }
}

let prisma = global.prismaGlobal ?? createPrismaClient();

if (!prisma.offer) {
  prisma = createPrismaClient();
  if (process.env.NODE_ENV !== "production") {
    global.prismaGlobal = prisma;
  }
}

export default prisma;
