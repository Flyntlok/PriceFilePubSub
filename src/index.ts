import { RowDataPacket, createPool } from 'mysql2/promise';

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_SCHEMA = process.env.DB_SCHEMA || 'price_file_consumption';
const DB_USER = process.env.DB_USER || 'myuser';
const DB_PASS = process.env.DB_PASS || 'myuser';

const pool = createPool({
  database: DB_SCHEMA,
  host: DB_HOST,
  password: DB_PASS,
  user: DB_USER,
  connectionLimit: 20,
  multipleStatements: true,
  dateStrings: true,
  supportBigNumbers: true,
});

let continueProcess = true;

process.on('SIGTERM', () => {
  console.log(
    'SIGTERM received. Finishing remaining processing and terminating'
  );
  continueProcess = false;
});

async function main() {
  do {
    await Promise.all([handleBroadcast(), handleConsume()]);
    await sleep(600);
    // process.exit(0);
  } while (continueProcess);

  process.exit(0);
}

async function handleBroadcast() {
  const mysqlConn = await pool.getConnection();
  try {
    // select from topic table
    const [res] = await mysqlConn.query(
      ` SELECT * from price_file_consumption.topic limit 1;
      `
    );

    if (res[0]) {
      const result = res[0];
      const id = result.id;
      const topic_name = result.topic_name;
      const event_name = result.event_name;
      const payload = result.payload;

      // check subscriber
      const [subscriber] = await mysqlConn.query(
        ` SELECT *
          FROM price_file_consumption.topic_subscription_map
          WHERE topic_name= ?;
        `,
        [topic_name]
      );

      const tables = Object.values(subscriber).map((x) => x.subscription_name);

      // insert into subscriber
      if (tables) {
        for (let i = 0; i < tables.length; i += 1) {
          const jsonValue = Object.keys(payload)
            .flatMap((x) => {
              return [`'${x}'`, `'${payload[x]}'`];
            })
            .join(',');

          await mysqlConn.query(
            ` INSERT INTO ${tables[i]} (msg_id, subscription_name, event_name, payload)
              VALUES (?, ?, ?, json_object(${jsonValue}));
            `,
            [id, topic_name, event_name]
          );
        }
      }

      // remove from topic table.
      await mysqlConn.query(
        ` DELETE FROM price_file_consumption.topic
          WHERE id=?;
        `,
        [id]
      );
    } else {
      console.log('no record found in item master');
    }
    await mysqlConn.release();
  } catch (err) {
    console.log('Broadcast price file updating error.', err);
  }
}

async function handleConsume() {
  const mysqlConn = await pool.getConnection();
  try {
    const subscriptionName = 'Item Genome Event';
    const [res] = await mysqlConn.query(
      ` CALL price_file_consumption.Pubsub_Receive_Subscription_Message(?);
      `,
      [subscriptionName]
    );

    const msgId = res[0][0]['@msg_id'];
    console.log('msgId: ', msgId);
    /* Based on Stephen's suggestion, move this Update_Item_Master sproc logic in here.6/12/2024
    if (msgId && item_no && distributor_id && manufacturer_id) {
      const [res2] = await mysqlConn.query(
        ` CALL price_file_consumption.Update_Item_Master(?, ?, ?, @outVal);
          SELECT @outval AS result;
        `,
        [item_no, distributor_id, manufacturer_id]
      );
      // console.log(res2);
    }
    */

    if (msgId) {
      const item_no = res[0][0]['@item_no'].replace(/"/g, '');
      const distributor_id = parseInt(
        res[0][0]['@distributor_id'].replace(/"/g, '')
      );
      const manufacturer_id = parseInt(
        res[0][0]['@manufacturer_id'].replace(/"/g, '')
      );
      console.log('item_no: ', item_no);
      console.log('distributor_id: ', distributor_id);
      console.log('manufacturer_id: ', manufacturer_id);
      // 1. select items from different tenants that need to be udpated by this msg
      const [vendorRows] = await mysqlConn.query<VendorRows[]>(
        ` select im.id, pm.tenant_id as tenant_id
          from prod.item_master as im
          join prod.p3_make as pm
          on im.vendor_id=pm.id
          where pm.distributor_id = ?
          and manufacturer_id = ?
          and item_no = ?
        `,
        [distributor_id, manufacturer_id, item_no]
      );

      if (vendorRows) {
        for (const raw of vendorRows) {
          const item_id = raw.id;
          const tenant_id = raw.tenant_id;
          console.log('item_id: ', item_id);
          console.log('tenant_id: ', tenant_id);
          // 2. prepare data
          // get tenant pricing group ids
          const [[priceGroupIds]] = await mysqlConn.query<PriceGrpupIds[]>(
            ` CALL price_file_consumption.Get_Tenant_Pricing_Group_IDs_v2(?, ?);
            `,
            [tenant_id, distributor_id]
          );

          console.log('priceGroupIds: ', priceGroupIds);
          const priceGroupResult =
            priceGroupIds && priceGroupIds[0] && priceGroupIds[0].result;
          const listGroupIds = priceGroupResult && priceGroupResult.list;
          const costGroupIds = priceGroupResult && priceGroupResult.cost;

          // get item_genome data
          const [[itemGenomeData]] = await mysqlConn.query<ItemGenomeData[]>(
            ` CALL price_file_consumption.Get_Item_Genome_Data(?, ?);
            `,
            [item_no, manufacturer_id]
          );

          console.log('itemGenomeData: ', itemGenomeData);
          const genoemResult =
            itemGenomeData && itemGenomeData[0] && itemGenomeData[0].result;
          const description = genoemResult && genoemResult.description;

          // get distributor_cost price
          const [[costPricings]] = await mysqlConn.query<CostPricingData[]>(
            ` CALL price_file_consumption.Get_Distributor_Cost_Pricing(?, ?, ?);
            `,
            [item_no, manufacturer_id, distributor_id]
          );

          console.log('costPricings: ', costPricings);
          const costResult =
            costPricings && costPricings[0] && costPricings[0].result;
          const costIds = costResult && costResult.costIds;
          const costPrices = costResult && costResult.costPrices;

          // get distributor_list price
          const [[listPricings]] = await mysqlConn.query<ListPricingData[]>(
            ` CALL price_file_consumption.Get_Distributor_List_Pricing(?, ?, ?);
            `,
            [item_no, manufacturer_id, distributor_id]
          );

          console.log('listPricings: ', listPricings);
          const listResult =
            listPricings && listPricings[0] && listPricings[0].result;
          const listIds = listResult && listResult.listIds;
          const listPrices = listResult && listResult.listPrices;

          // compare and pick the right cost/list price
          const costIdsArray = costIds && costIds.split(',');
          const costPricesArray = costPrices && costPrices.split(',');
          const costGroupIdsArray = costGroupIds && costGroupIds.split(',');
          let currentCost = 0;
          let currentList = 0;
          costIdsArray.forEach((id, index) => {
            const cost = costPricesArray[index];
            costGroupIdsArray.forEach((groupId) => {
              if (groupId == id) {
                currentCost = cost;
              }
            });
          });

          const listIdsArray = listIds && listIds.split(',');
          const listPricesArray = listPrices && listPrices.split(',');
          const listGroupIdsArray = listGroupIds && listGroupIds.split(',');
          listIdsArray.forEach((id, index) => {
            const list = listPricesArray[index];
            listGroupIdsArray.forEach((groupId) => {
              if (groupId == id) {
                currentList = list;
              }
            });
          });

          // 3. update item_master/ update item inventory
          await mysqlConn.query(
            ` UPDATE prod.item_master
              SET description= ?, item_msrp = round(?, 2), item_cost = round(?, 2)
              WHERE id= ?
            `,
            [description, currentList, currentCost, item_id]
          );
        }
      }

      await mysqlConn.query(
        ` CALL price_file_consumption.Pubsub_Acknowledge_Item(?);
        `,
        [msgId]
      );
    } else {
      console.log('no data to update.');
    }

    await mysqlConn.release();
  } catch (err) {
    console.log('Consume price file updating error.', err);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

interface VendorRows extends RowDataPacket {
  id: string;
  tenant_id: string;
}

interface PriceGrpupIds extends RowDataPacket {
  tenantListGroupIds: string;
  tenantCostGroupIds: string;
}

interface ItemGenomeData extends RowDataPacket {
  description: string;
}

interface CostPricingData extends RowDataPacket {
  costIds: string;
  costPrices: string;
}

interface ListPricingData extends RowDataPacket {
  listIds: string;
  listPrices: string;
}
